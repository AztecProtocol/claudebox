/**
 * HostClient — MCP sidecar ↔ ClaudeBox server communication.
 *
 * Thin HTTP client for composite server endpoints that orchestrate
 * multi-service operations (Slack + GitHub comment updates, DMs).
 *
 * Only used from mcp/base.ts. Direct API calls go through libcreds instead.
 */

import { existsSync, readFileSync, appendFileSync } from "fs";

export interface HostClientOpts {
  /** Profile name (e.g. "default", "barretenberg-audit") */
  profile: string;
  /** Server URL (e.g. "http://host.docker.internal:3000") — if unset, degrades gracefully */
  serverUrl?: string;
  /** Auth token for server internal API */
  serverToken?: string;
  /** Session metadata — passed to server for context */
  sessionMeta?: Record<string, string>;
}

export interface CommentSections {
  status: string;
  statusLog: Array<{ ts: string; text: string }>;
  response: string;
}

export class HostClient {
  readonly profile: string;
  readonly serverUrl: string | undefined;
  private readonly token: string;
  readonly hasServer: boolean;
  readonly activityLog: string;
  private sessionMeta: Record<string, string>;

  constructor(opts: HostClientOpts) {
    this.profile = opts.profile;
    this.serverUrl = opts.serverUrl?.replace(/\/$/, "");
    this.token = opts.serverToken || "";
    this.hasServer = !!(this.serverUrl && this.token);
    this.activityLog = "/workspace/activity.jsonl";
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
        const isUpdate = /updated/i.test(text);
        if (this._seenArtifactUrls.has(cleanUrl) && !isUpdate) return;
        this._seenArtifactUrls.add(cleanUrl);
      }
    }
    try {
      const entry: Record<string, string> = { ts: new Date().toISOString(), type, text };
      const logId = this.sessionMeta?.log_id;
      if (logId) entry.log_id = logId;
      appendFileSync(this.activityLog, JSON.stringify(entry) + "\n");
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

  // ── Root comment update ──────────────────────────────────────

  /**
   * Update the root comment (Slack message + GitHub comment).
   * Returns status strings like ["Slack updated", "GitHub updated"].
   * Without a server, writes to activity log only.
   */
  async updateComment(body: {
    status?: string;
    logId?: string;
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
      console.error(`[HostClient] DM failed: ${e.message}`);
    }
  }

  // ── Claim work (dedup) ───────────────────────────────────────

  async claimWork(workDescription: string): Promise<{ sessions: any[] } | null> {
    if (!this.hasServer) return null;
    const logId = this.sessionMeta?.log_id;
    if (!logId) return null;
    return this.serverFetch("/api/internal/claim-work", {
      body: { log_id: logId, work_description: workDescription, profile: this.profile },
    });
  }

  // ── Cron operations ─────────────────────────────────────────

  async listCrons(channelId?: string): Promise<any[]> {
    if (!this.hasServer) return [];
    const qs = channelId ? `?channel=${channelId}` : "";
    return (await this.serverFetch(`/api/internal/crons${qs}`, { method: "GET" })) || [];
  }

  async createCron(opts: { channel_id: string; name: string; schedule: string; prompt: string; user?: string }): Promise<any> {
    return this.serverFetch("/api/internal/crons", { body: opts });
  }

  async updateCron(id: string, patch: Record<string, any>): Promise<any> {
    return this.serverFetch(`/api/internal/crons/${id}`, { method: "PUT", body: patch });
  }

  async deleteCron(id: string): Promise<any> {
    return this.serverFetch(`/api/internal/crons/${id}`, { method: "DELETE" });
  }

  // ── Session metadata ─────────────────────────────────────────

  updateRunMeta(meta: Record<string, string>): void {
    this.sessionMeta = { ...this.sessionMeta, ...meta };
  }
}

/**
 * Create a HostClient from environment variables.
 * Standard env vars set by docker.ts:
 *   CLAUDEBOX_SERVER_URL, CLAUDEBOX_SERVER_TOKEN, CLAUDEBOX_PROFILE
 */
export function createHostClientFromEnv(extraMeta?: Record<string, string>): HostClient {
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
    CLAUDEBOX_HOST: "host",
    CLAUDEBOX_BASE_BRANCH: "base_branch",
  };
  for (const [env, key] of Object.entries(envMap)) {
    if (process.env[env]) meta[key] = process.env[env]!;
  }
  if (extraMeta) Object.assign(meta, extraMeta);

  return new HostClient({
    profile: process.env.CLAUDEBOX_PROFILE || "default",
    serverUrl: process.env.CLAUDEBOX_SERVER_URL,
    serverToken: process.env.CLAUDEBOX_SERVER_TOKEN,
    sessionMeta: meta,
  });
}
