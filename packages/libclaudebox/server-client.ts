/**
 * ServerClient — MCP sidecar ↔ ClaudeBox server communication.
 *
 * Provides a unified interface for sidecar tools to communicate with the
 * claudebox server. Abstracts away whether the server is local, remote, or absent.
 *
 * Graceful degradation: when no server URL is configured, Slack/comment operations
 * are no-ops (logged to activity only), and profileApi() throws.
 */

import { appendFileSync, existsSync, readFileSync } from "fs";

export interface ServerClientOpts {
  /** Profile name (e.g. "default", "barretenberg-audit") */
  profile: string;
  /** Server URL (e.g. "http://host.docker.internal:3000") — if unset, degrades gracefully */
  serverUrl?: string;
  /** Auth token for server internal API */
  serverToken?: string;
  /** Activity log path (local JSONL file) */
  activityLog?: string;
  /** Session metadata — passed to server for context */
  sessionMeta?: Record<string, string>;
}

export interface CommentSections {
  status: string;
  statusLog: Array<{ ts: string; text: string }>;
  response: string;
}

export class ServerClient {
  readonly profile: string;
  readonly serverUrl: string | undefined;
  private readonly token: string;
  private readonly activityLog: string;
  readonly hasServer: boolean;
  private sessionMeta: Record<string, string>;

  constructor(opts: ServerClientOpts) {
    this.profile = opts.profile;
    this.serverUrl = opts.serverUrl?.replace(/\/$/, "");
    this.token = opts.serverToken || "";
    this.activityLog = opts.activityLog || "/workspace/activity.jsonl";
    this.hasServer = !!(this.serverUrl && this.token);
    this.sessionMeta = opts.sessionMeta || {};
  }

  // ── Activity log (always local) ──────────────────────────────

  private _seenArtifactUrls = new Set<string>();
  private _activityInitialized = false;

  private initActivityDedup(): void {
    if (this._activityInitialized) return;
    this._activityInitialized = true;
    try {
      if (existsSync(this.activityLog)) {
        for (const line of readFileSync(this.activityLog, "utf-8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "artifact") {
              const m = entry.text?.match(/(https?:\/\/[^\s)>\]]+)/);
              if (m) this._seenArtifactUrls.add(m[1].replace(/[.,;:!?]+$/, ""));
            }
          } catch {}
        }
      }
    } catch {}
  }

  logActivity(type: string, text: string): void {
    this.initActivityDedup();
    if (type === "artifact") {
      const urlMatch = text.match(/(https?:\/\/[^\s)>\]]+)/);
      if (urlMatch) {
        const cleanUrl = urlMatch[1].replace(/[.,;:!?]+$/, "");
        if (this._seenArtifactUrls.has(cleanUrl)) return;
        this._seenArtifactUrls.add(cleanUrl);
      }
    }
    try {
      appendFileSync(this.activityLog, JSON.stringify({ ts: new Date().toISOString(), type, text }) + "\n");
    } catch {}
  }

  // ── Server HTTP helpers ──────────────────────────────────────

  private async serverFetch(path: string, opts?: { method?: string; body?: any }): Promise<any> {
    if (!this.hasServer) return null;
    const method = opts?.method || "POST";
    const url = `${this.serverUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        "X-ClaudeBox-Profile": this.profile,
      },
      ...(opts?.body !== undefined && { body: JSON.stringify(opts.body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Server ${res.status}: ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) return res.json();
    return res.text();
  }

  // ── Slack (proxied through server) ───────────────────────────

  /**
   * Call a Slack Web API method through the server.
   * Returns the API response, or { ok: false, error: "no_server" } if no server.
   */
  async slack(method: string, args: Record<string, any>): Promise<any> {
    if (!this.hasServer) {
      return { ok: false, error: "no_server", hint: "No claudebox server configured — Slack operations unavailable" };
    }
    return this.serverFetch("/api/internal/slack", {
      body: { method, args, session: this.sessionMeta },
    });
  }

  // ── Root comment update ──────────────────────────────────────

  /**
   * Update the root comment (Slack message + GitHub comment).
   * Returns status strings like ["Slack updated", "GitHub updated"].
   * Without a server, writes to activity log only.
   */
  async updateComment(body: {
    status?: string;
    sections: CommentSections;
    trackedPRs: Array<{ num: number; title: string; url: string; action: string }>;
    otherArtifacts: string[];
  }): Promise<string[]> {
    if (!this.hasServer) {
      return ["No server configured — status logged locally only"];
    }
    const result = await this.serverFetch("/api/internal/comment", {
      body: { ...body, session: this.sessionMeta },
    });
    return result?.results || [];
  }

  // ── DM author on completion ──────────────────────────────────

  async dmAuthor(body: {
    status: string;
    trackedPRs: Array<{ num: number; title: string; url: string; action: string }>;
  }): Promise<void> {
    if (!this.hasServer) return;
    try {
      await this.serverFetch("/api/internal/dm", {
        body: { ...body, session: this.sessionMeta },
      });
    } catch (e: any) {
      console.error(`[ServerClient] DM failed: ${e.message}`);
    }
  }

  // ── Profile-specific API ─────────────────────────────────────

  /**
   * Call a profile-specific server endpoint.
   * Routes to: /api/profiles/<profile>/<path>
   * Throws if no server is configured.
   */
  async profileApi(method: string, path: string, body?: any): Promise<any> {
    if (!this.hasServer) {
      throw new Error(`Profile API requires a claudebox server (no CLAUDEBOX_SERVER_URL configured)`);
    }
    const cleanPath = path.replace(/^\//, "");
    return this.serverFetch(`/api/profiles/${this.profile}/${cleanPath}`, {
      method,
      body,
    });
  }

  // ── Session metadata ─────────────────────────────────────────

  updateSessionMeta(meta: Record<string, string>): void {
    this.sessionMeta = { ...this.sessionMeta, ...meta };
  }
}

/**
 * Create a ServerClient from environment variables.
 * Standard env vars set by docker.ts:
 *   CLAUDEBOX_SERVER_URL, CLAUDEBOX_SERVER_TOKEN, CLAUDEBOX_PROFILE
 */
export function createServerClientFromEnv(extraMeta?: Record<string, string>): ServerClient {
  const meta: Record<string, string> = {};
  // Collect session metadata from env
  const envMap: Record<string, string> = {
    CLAUDEBOX_LOG_ID: "log_id",
    CLAUDEBOX_LOG_URL: "log_url",
    CLAUDEBOX_WORKTREE_ID: "worktree_id",
    CLAUDEBOX_USER: "user",
    CLAUDEBOX_COMMENT_ID: "comment_id",
    CLAUDEBOX_RUN_COMMENT_ID: "run_comment_id",
    CLAUDEBOX_RUN_URL: "run_url",
    CLAUDEBOX_LINK: "link",
    CLAUDEBOX_SLACK_CHANNEL: "slack_channel",
    CLAUDEBOX_SLACK_THREAD_TS: "slack_thread_ts",
    CLAUDEBOX_SLACK_MESSAGE_TS: "slack_message_ts",
    CLAUDEBOX_HOST: "host",
    CLAUDEBOX_BASE_BRANCH: "base_branch",
  };
  for (const [env, key] of Object.entries(envMap)) {
    if (process.env[env]) meta[key] = process.env[env]!;
  }
  if (extraMeta) Object.assign(meta, extraMeta);

  return new ServerClient({
    profile: process.env.CLAUDEBOX_PROFILE || "default",
    serverUrl: process.env.CLAUDEBOX_SERVER_URL,
    serverToken: process.env.CLAUDEBOX_SERVER_TOKEN,
    activityLog: "/workspace/activity.jsonl",
    sessionMeta: meta,
  });
}
