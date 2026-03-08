import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { API_SECRET, SESSION_PAGE_USER, SESSION_PAGE_PASS, MAX_CONCURRENT, getActiveSessions, SLACK_BOT_TOKEN, getChannelBranches, DEFAULT_BASE_BRANCH, GH_TOKEN, CLAUDEBOX_DIR } from "./config.ts";
import { existsSync, readFileSync, readdirSync, statSync, watch, mkdirSync } from "fs";
import { join } from "path";
import type { SessionStore } from "./session-store.ts";
import type { DockerService } from "./docker.ts";
import type { SessionMeta, Artifact, EnrichedWorkspace, ThreadGroup, ChannelGroup } from "./types.ts";
import { workspacePageHTML, dashboardHTML, auditDashboardHTML, personalDashboardHTML, taggedDashboardHTML, type WorkspaceCard } from "./html/templates.ts";
import { parseMessage, parseKeywords, validateResumeSession, truncate, prKeyFromUrl } from "./util.ts";
import { QuestionStore } from "./question-store.ts";
import { tagBatch } from "./tagger.ts";
import { updateSlackStatus } from "./slack/helpers.ts";
import { getAllTagCategories, discoverPlugins } from "./plugin-loader.ts";

// ── Helpers ─────────────────────────────────────────────────────

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

// ── Auth (jose JWT) ─────────────────────────────────────────────

const JWT_SECRET = new TextEncoder().encode(API_SECRET || SESSION_PAGE_PASS);
const JWT_ISSUER = "claudebox";
const JWT_EXPIRY = "7d";
const COOKIE_NAME = "cb_session";

function checkApiAuth(req: IncomingMessage): boolean {
  if (!API_SECRET) return true;
  return (req.headers.authorization ?? "") === `Bearer ${API_SECRET}`;
}

async function checkSessionAuth(req: IncomingMessage): Promise<boolean> {
  // 1. Check JWT cookie (preferred — works with SSE EventSource)
  const cookies = req.headers.cookie || "";
  const match = cookies.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (match) {
    try {
      const { payload } = await jwtVerify(match[1], JWT_SECRET, { issuer: JWT_ISSUER });
      if (payload.sub === SESSION_PAGE_USER) return true;
    } catch {}
  }

  // 2. Fallback: Basic auth header (for API clients)
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const idx = decoded.indexOf(":");
    if (idx >= 0) {
      return decoded.slice(0, idx) === SESSION_PAGE_USER && decoded.slice(idx + 1) === SESSION_PAGE_PASS;
    }
  }

  return false;
}

async function issueSessionCookie(): Promise<string> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(SESSION_PAGE_USER)
    .setIssuer(JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(JWT_SECRET);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

function sendUnauthorized(res: ServerResponse, _type: "api" | "session"): void {
  json(res, 401, { error: "unauthorized" });
}

// ── Channel info resolution ─────────────────────────────────────

interface SlackChannelInfo {
  name: string;
  isDm: boolean;
}

// Static channel name map — loaded from ~/.claudebox/channel-cache.json
// Populate via: scripts/resolve-channels.sh or manually edit the JSON file
const channelNameMap = new Map<string, SlackChannelInfo>();
try {
  const data = JSON.parse(readFileSync(join(CLAUDEBOX_DIR, "channel-cache.json"), "utf-8"));
  for (const [k, v] of Object.entries(data)) channelNameMap.set(k, v as SlackChannelInfo);
  console.log(`[CHANNELS] Loaded ${channelNameMap.size} channel names`);
} catch {}

function getSlackChannelInfo(channelId: string): SlackChannelInfo | null {
  if (channelNameMap.has(channelId)) return channelNameMap.get(channelId)!;
  if (channelId.startsWith("D")) return { name: "", isDm: true };
  return null; // unknown channel — no info
}

/** Strip "Slack thread context..." suffix from prompts for display */
function stripSlackContext(prompt: string): string {
  // Match any variant: "Slack thread context:", "Slack thread context (recent):", etc.
  const match = prompt.match(/\n*Slack thread context[^\n]*:/);
  if (match && match.index != null && match.index > 0) {
    return prompt.slice(0, match.index).trim();
  }
  // Also strip if it starts with it (no user message before context)
  if (prompt.startsWith("Slack thread context")) return "";
  return prompt;
}

// ── Dashboard builder ──────────────────────────────────────────

async function buildDashboardData(store: SessionStore, profileFilter?: string): Promise<WorkspaceCard[]> {
  const all = store.listAll();

  // Group sessions by worktree_id (or by _log_id for sessions without a worktree)
  const worktreeMap = new Map<string, { sessions: any[]; worktreeId: string }>();
  for (const s of all) {
    // Profile filtering: when profileFilter is set, only include matching sessions;
    // when unset (default dashboard), exclude audit sessions
    const sessionProfile = s.profile || "";
    if (profileFilter === "*") {
      // show all
    } else if (profileFilter === "default" || !profileFilter) {
      // "default" catches sessions with no profile or profile="default"
      if (sessionProfile && sessionProfile !== "default") continue;
    } else if (profileFilter) {
      if (sessionProfile !== profileFilter) continue;
    }
    const key = s.worktree_id || `_single_${s._log_id}`;
    if (!worktreeMap.has(key)) worktreeMap.set(key, { sessions: [], worktreeId: s.worktree_id || "" });
    worktreeMap.get(key)!.sessions.push(s);
  }

  // Collect unique channel IDs and resolve names in parallel
  const channelIds = new Set<string>();
  for (const [, { sessions }] of worktreeMap) {
    const channelId = sessions[0]?.slack_channel || "";
    if (channelId) channelIds.add(channelId);
  }
  const channelInfoMap = new Map<string, SlackChannelInfo>();
  for (const id of channelIds) channelInfoMap.set(id, getSlackChannelInfo(id));

  // Build flat workspace list
  const workspaces: WorkspaceCard[] = [];
  for (const [_key, { sessions, worktreeId }] of worktreeMap) {
    const latest = sessions[0]; // already sorted newest first
    const channelId = latest.slack_channel || "";

    const info = channelInfoMap.get(channelId);
    if (info?.isDm) continue; // skip DMs and group DMs
    const meta = worktreeId ? store.getWorktreeMeta(worktreeId) : {};
    const channelName = info?.name || latest.slack_channel_name || "";

    // Determine origin
    const slackChannel = latest.slack_channel || "";
    const slackThread = latest.slack_thread_ts || "";
    const link = latest.link || "";
    let origin = "http";
    let threadKey: string | undefined;
    if (slackChannel && slackThread) {
      origin = "slack";
      threadKey = `${slackChannel}:${slackThread}`;
    } else if (link) {
      origin = "github";
    }

    workspaces.push({
      worktreeId: worktreeId || latest._log_id || "?",
      name: meta.name || null,
      resolved: !!meta.resolved,
      alive: worktreeId ? store.isWorktreeAlive(worktreeId) : false,
      status: latest.status || "unknown",
      exitCode: latest.exit_code ?? null,
      user: latest.user || "unknown",
      prompt: stripSlackContext(latest.prompt || ""),
      started: latest.started || null,
      baseBranch: latest.base_branch || "next",
      channelName,
      runCount: sessions.length,
      profile: latest.profile || "",
      origin,
      threadKey,
      link: link || undefined,
    });
  }

  // Sort: running first, then by start time newest first
  workspaces.sort((a, b) => {
    const aRunning = a.status === "running" ? 1 : 0;
    const bRunning = b.status === "running" ? 1 : 0;
    if (aRunning !== bRunning) return bRunning - aRunning;
    return (b.started || "").localeCompare(a.started || "");
  });

  return workspaces;
}

// ── Session resolution ──────────────────────────────────────────

/** Resolve a URL param to a worktree ID and session. Handles:
 *  - 16-hex worktree ID (primary)
 *  - <worktreeId>-<seq> session log ID
 *  - 32-hex legacy session hash
 */
function resolveSession(param: string, store: SessionStore): { worktreeId: string; session: SessionMeta } | null {
  // Try as worktree ID (16 hex) — returns latest session
  if (/^[a-f0-9]{16}$/.test(param)) {
    const session = store.findByWorktreeId(param);
    if (session) return { worktreeId: param, session };
  }
  // Try as new-format log ID: <worktreeId>-<seq>
  if (/^[a-f0-9]{16}-\d+$/.test(param)) {
    const session = store.findByHash(param);
    if (session) return { worktreeId: session.worktree_id || param.slice(0, 16), session };
  }
  // Try as legacy 32-hex hash
  if (/^[a-f0-9]{32}$/.test(param)) {
    const session = store.findByHash(param);
    if (session) return { worktreeId: session.worktree_id || "", session };
  }
  return null;
}

// ── Route definitions ───────────────────────────────────────────

type RouteHandler = (
  req: IncomingMessage, res: ServerResponse, params: Record<string, string>,
  ctx: { store: SessionStore; docker: DockerService },
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  auth: "api" | "basic" | "none";
  paramNames?: string[];
  handler: RouteHandler;
}

const routes: Route[] = [
  // GET /health — unauthenticated health check
  {
    method: "GET", pattern: /^\/health$/, auth: "none",
    handler: async (_req, res, _params, { store }) => {
      json(res, 200, { status: "ok", active: getActiveSessions(), max: MAX_CONCURRENT });
    },
  },

  // POST /run — start a ClaudeBox session
  {
    method: "POST", pattern: /^\/run$/, auth: "api",
    handler: async (req, res, _params, { store, docker }) => {
      if (getActiveSessions() >= MAX_CONCURRENT) {
        json(res, 503, { error: "at capacity", active: getActiveSessions(), max: MAX_CONCURRENT });
        return;
      }
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      let prompt: string = body.prompt ?? "";
      if (!prompt) { json(res, 400, { error: "prompt required" }); return; }

      // Parse keywords (ci-allow, profile, etc.) from prompt text
      const keywords = parseKeywords({ type: "fresh", prompt });
      const ciAllow = keywords.ciAllow;
      const runProfile = body.profile || keywords.profile || "";
      prompt = keywords.prompt;

      let worktreeId = body.worktree_id || "";
      const parsed = worktreeId ? null : parseMessage(prompt, (h) => store.findByHash(h));

      let resumedSession: any = null;
      if (!worktreeId && parsed?.type === "reply-hash") {
        const prevSession = store.findByHash(parsed.hash);
        const err = validateResumeSession(prevSession, parsed.hash);
        if (err) { json(res, 400, { error: err }); return; }
        worktreeId = prevSession!.worktree_id || "";
        resumedSession = prevSession;
      }

      // PR binding: reuse the worktree already associated with this PR
      const prKey = body.link ? prKeyFromUrl(body.link) : null;
      if (!worktreeId && prKey) {
        const bound = store.getPrBinding(prKey);
        if (bound) {
          const prev = store.findByWorktreeId(bound);
          if (prev?.status === "running") { json(res, 409, { error: "Session already running for this PR" }); return; }
          if (prev?.worktree_id && store.isWorktreeAlive(prev.worktree_id)) {
            worktreeId = prev.worktree_id;
            resumedSession = resumedSession || prev;
            console.log(`[HTTP] PR binding ${prKey} → worktree ${worktreeId}`);
          }
        }
      }

      console.log(`[HTTP] POST /run user=${body.user ?? "?"} prompt=${truncate(prompt, 120)}${worktreeId ? ` (worktree=${worktreeId})` : ""}`);

      let responded = false;
      docker.runContainerSession({
        prompt: parsed?.type === "reply-hash" ? parsed.prompt : prompt,
        userName: body.user,
        commentId: body.comment_id,
        runCommentId: body.run_comment_id,
        runUrl: body.run_url,
        link: body.link,
        worktreeId: worktreeId || undefined,
        targetRef: body.target_ref || undefined,
        ciAllow,
        profile: (resumedSession?.profile || runProfile) || undefined,
        model: body.model || undefined,
      }, store, undefined, (logUrl, newWorktreeId) => {
        if (prKey) store.bindPr(prKey, newWorktreeId);
        if (!responded) {
          responded = true;
          json(res, 202, { log_url: logUrl, worktree_id: newWorktreeId, status: "started" });
        }
      }).catch((e) => {
        console.error(`[HTTP] Session error: ${e}`);
        if (!responded) {
          responded = true;
          console.error(`[HTTP] ${e.message}`); json(res, 500, { error: "internal error" });
        }
      });
    },
  },

  // GET /session/:id — session status (JSON API)
  {
    method: "GET", pattern: /^\/session\/([a-f0-9][\w-]+)$/, auth: "api",
    handler: async (_req, res, params, { store }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved) { json(res, 404, { error: "not found" }); return; }
      const session = resolved.session;
      json(res, 200, {
        status: session.status,
        log_url: session.log_url,
        user: session.user,
        started: session.started,
        finished: session.finished,
        exit_code: session.exit_code,
        worktree_id: session.worktree_id || "",
      });
    },
  },

  // GET /session/:id/bundle — download session JSONL bundle (tar)
  {
    method: "GET", pattern: /^\/session\/([a-f0-9][\w-]+)\/bundle$/, auth: "api",
    handler: async (_req, res, params, { store }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved?.worktreeId) { json(res, 404, { error: "not found or no worktree" }); return; }
      const claudeProjectsDir = join(store.worktreesDir, resolved.worktreeId, "claude-projects");
      if (!existsSync(claudeProjectsDir)) { json(res, 404, { error: "no session data" }); return; }

      // Stream tar of claude-projects dir
      const { execFileSync } = await import("child_process");
      try {
        const tarData = execFileSync("tar", ["-c", "-C", claudeProjectsDir, "."], { maxBuffer: 50 * 1024 * 1024 });
        res.writeHead(200, {
          "Content-Type": "application/x-tar",
          "Content-Disposition": `attachment; filename="${resolved.worktreeId}-session.tar"`,
          "X-Worktree-Id": resolved.worktreeId,
          "X-Session-Profile": resolved.session.profile || "",
        });
        res.end(tarData);
      } catch (e: any) {
        json(res, 500, { error: `tar failed: ${e.message}` });
      }
    },
  },

  // POST /session/:id/bundle — upload session JSONL bundle (tar), enqueue resume
  {
    method: "POST", pattern: /^\/session\/([a-f0-9][\w-]+)\/bundle$/, auth: "api",
    handler: async (req, res, params, { store }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved?.worktreeId) { json(res, 404, { error: "not found or no worktree" }); return; }
      const claudeProjectsDir = join(store.worktreesDir, resolved.worktreeId, "claude-projects");
      mkdirSync(claudeProjectsDir, { recursive: true });

      // Read tar from request body
      const chunks: Buffer[] = [];
      let total = 0;
      const MAX = 50 * 1024 * 1024; // 50MB
      await new Promise<void>((resolve, reject) => {
        req.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX) { req.destroy(); reject(new Error("bundle too large")); return; }
          chunks.push(c);
        });
        req.on("end", resolve);
        req.on("error", reject);
      });

      const { execFileSync } = await import("child_process");
      try {
        execFileSync("tar", ["-x", "-C", claudeProjectsDir], { input: Buffer.concat(chunks) });
        json(res, 200, { ok: true, worktree_id: resolved.worktreeId });
      } catch (e: any) {
        json(res, 500, { error: `untar failed: ${e.message}` });
      }
    },
  },

  // GET /dashboard — workspace dashboard
  {
    method: "GET", pattern: /^\/dashboard$/, auth: "none",
    handler: async (_req, res) => {
      html(res, 200, dashboardHTML());
    },
  },

  // GET /audit — audit dashboard (barretenberg-audit profile)
  {
    method: "GET", pattern: /^\/audit$/, auth: "none",
    handler: async (_req, res) => {
      html(res, 200, auditDashboardHTML());
    },
  },

  // GET / — redirect to dashboard
  {
    method: "GET", pattern: /^\/$/, auth: "none",
    handler: async (_req, res) => {
      res.writeHead(302, { Location: "/dashboard" });
      res.end();
    },
  },

  // POST /login — validate credentials and set JWT session cookie
  {
    method: "POST", pattern: /^\/login$/, auth: "none",
    handler: async (req, res) => {
      const body = JSON.parse(await readBody(req));
      const { username, password } = body;
      if (username === SESSION_PAGE_USER && password === SESSION_PAGE_PASS) {
        const cookie = await issueSessionCookie();
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": cookie });
        res.end('{"ok":true}');
      } else {
        json(res, 401, { error: "invalid credentials" });
      }
    },
  },

  // POST /logout — clear session cookie
  {
    method: "POST", pattern: /^\/logout$/, auth: "none",
    handler: async (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
      });
      res.end('{"ok":true}');
    },
  },

  // POST /auth-check — validate session (cookie or Basic header)
  {
    method: "POST", pattern: /^\/auth-check$/, auth: "none",
    handler: async (req, res) => {
      if (await checkSessionAuth(req)) {
        json(res, 200, { ok: true });
      } else {
        json(res, 401, { ok: false, error: "invalid credentials" });
      }
    },
  },

  // GET /s/<id> — workspace status page (client-side auth like dashboard)
  {
    method: "GET", pattern: /^\/s\/([a-f0-9][\w-]+)$/, auth: "none",
    handler: async (_req, res, params, { store }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Session not found"); return; }

      const { worktreeId, session } = resolved;
      // If accessed by session log ID, redirect to canonical worktree URL
      if (worktreeId && params[0] !== worktreeId) {
        res.writeHead(302, { Location: `/s/${worktreeId}` });
        res.end();
        return;
      }

      const hash = session._log_id || params[0];
      const sessions = worktreeId ? store.listByWorktree(worktreeId) : [{ ...session, _log_id: hash }];
      const worktreeAlive = worktreeId ? store.isWorktreeAlive(worktreeId) : false;
      // Activity loaded client-side after auth (via SSE) — don't leak in HTML
      html(res, 200, workspacePageHTML({ hash, session, sessions, worktreeAlive, activity: [] }));
    },
  },

  // GET /s/<id>/activity — JSON activity feed (initial load + polling fallback)
  {
    method: "GET", pattern: /^\/s\/([a-f0-9][\w-]+)\/activity$/, auth: "basic",
    handler: async (req, res, params, { store }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved) { json(res, 404, { error: "not found" }); return; }
      const { worktreeId, session } = resolved;
      const activity = worktreeId ? store.readActivity(worktreeId).reverse() : []; // oldest first
      const sessions = worktreeId ? store.listByWorktree(worktreeId) : [];
      json(res, 200, {
        activity,
        status: session.status || "unknown",
        exit_code: session.exit_code ?? null,
        user: session.user || "unknown",
        sessions: sessions.map(s => ({
          log_id: s._log_id, status: s.status, exit_code: s.exit_code,
          started: s.started, prompt: s.prompt, user: s.user, log_url: s.log_url,
        })),
      });
    },
  },

  // GET /s/<id>/events — SSE stream of new activity entries
  {
    method: "GET", pattern: /^\/s\/([a-f0-9][\w-]+)\/events$/, auth: "basic",
    handler: async (_req, res, params, { store }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved) { json(res, 404, { error: "not found" }); return; }
      const { worktreeId, session } = resolved;
      if (!worktreeId) { json(res, 400, { error: "no worktree" }); return; }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Send current state as initial event
      const activity = store.readActivity(worktreeId).reverse(); // oldest first
      const currentSession = store.findByWorktreeId(worktreeId);
      res.write(`data: ${JSON.stringify({ type: "init", activity, status: currentSession?.status || "unknown", exit_code: currentSession?.exit_code ?? null })}\n\n`);

      let lineCount = activity.length;
      const activityPath = join(store.worktreesDir, worktreeId, "workspace", "activity.jsonl");

      // Poll for new lines (fs.watch is unreliable in Docker bind mounts)
      const poll = setInterval(() => {
        try {
          if (!existsSync(activityPath)) return;
          const lines = readFileSync(activityPath, "utf-8").split("\n").filter(l => l.trim());
          if (lines.length > lineCount) {
            const newEntries = lines.slice(lineCount).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            for (const entry of newEntries) {
              res.write(`data: ${JSON.stringify({ type: "activity", entry })}\n\n`);
              // Auto-set workspace name from Claude's set_workspace_name tool
              if (entry.type === "name" && entry.text && worktreeId) {
                store.setWorktreeName(worktreeId, entry.text);
              }
            }
            lineCount = lines.length;
          }
          // Also check for status changes
          const latest = store.findByWorktreeId(worktreeId);
          if (latest) {
            res.write(`data: ${JSON.stringify({ type: "status", status: latest.status || "unknown", exit_code: latest.exit_code ?? null })}\n\n`);
          }
        } catch {}
      }, 1500);

      // Keepalive
      const keepalive = setInterval(() => { res.write(": keepalive\n\n"); }, 15000);

      res.on("close", () => { clearInterval(poll); clearInterval(keepalive); });
    },
  },

  // GET /api/users — list known user identities
  {
    method: "GET", pattern: /^\/api\/users$/, auth: "basic",
    handler: async (_req, res, _params, { store }) => {
      json(res, 200, { users: store.knownUsers() });
    },
  },

  // GET /api/dashboard — workspace data as JSON (supports ?profile=X filter)
  {
    method: "GET", pattern: /^\/api\/dashboard$/, auth: "basic",
    handler: async (req, res, _params, { store }) => {
      const url = new URL(req.url || "/", "http://localhost");
      const profileFilter = url.searchParams.get("profile") || undefined;
      const workspaces = await buildDashboardData(store, profileFilter);
      json(res, 200, { workspaces, activeCount: getActiveSessions(), maxConcurrent: MAX_CONCURRENT });
    },
  },

  // GET /api/branches — available base branches
  {
    method: "GET", pattern: /^\/api\/branches$/, auth: "basic",
    handler: async (_req, res) => {
      const branches = [DEFAULT_BASE_BRANCH, ...Object.values(getChannelBranches())];
      json(res, 200, { branches: [...new Set(branches)] });
    },
  },

  // GET /api/profiles — available profile names
  {
    method: "GET", pattern: /^\/api\/profiles$/, auth: "basic",
    handler: async (_req, res) => {
      json(res, 200, { profiles: discoverPlugins() });
    },
  },

  // GET /api/tags — all known tags
  {
    method: "GET", pattern: /^\/api\/tags$/, auth: "basic",
    handler: async (_req, res, _params, { store }) => {
      json(res, 200, { tags: store.allTags() });
    },
  },

  // POST /api/tags — tag untagged workspaces via claude. ?limit=N to cap (default: all)
  {
    method: "POST", pattern: /^\/api\/tags$/, auth: "basic",
    handler: async (req, res, _params, { store }) => {
      const url = new URL(req.url || "", "http://localhost");
      const limit = parseInt(url.searchParams.get("limit") || "0", 10) || 0;

      const all = store.listAll();
      const untagged: { id: string; prompt: string }[] = [];
      const seen = new Set<string>();
      for (const s of all) {
        const wid = s.worktree_id;
        if (!wid || seen.has(wid)) continue;
        seen.add(wid);
        if (store.getWorktreeTags(wid).length > 0) continue;
        if (!s.prompt) continue;
        untagged.push({ id: wid, prompt: s.prompt });
        if (limit > 0 && untagged.length >= limit) break;
      }

      if (untagged.length === 0) { json(res, 200, { tagged: 0, remaining: 0 }); return; }

      const existing = store.allTags();
      let tagged = 0;
      const results = await tagBatch(untagged, existing);
      for (const [wid, tags] of results) {
        store.setWorktreeTags(wid, tags);
        tagged++;
      }

      // Count remaining untagged
      let remaining = 0;
      const seenAll = new Set<string>();
      for (const s of all) {
        const wid = s.worktree_id;
        if (!wid || seenAll.has(wid)) continue;
        seenAll.add(wid);
        if (store.getWorktreeTags(wid).length === 0 && s.prompt) remaining++;
      }

      console.log(`[TAGGER] Tagged ${tagged}, ${remaining} remaining`);
      json(res, 200, { tagged, remaining });
    },
  },

  // POST /api/sessions — start a new session from the dashboard
  {
    method: "POST", pattern: /^\/api\/sessions$/, auth: "basic",
    handler: async (req, res, _params, { store, docker }) => {
      if (getActiveSessions() >= MAX_CONCURRENT) {
        json(res, 503, { ok: false, message: "At capacity" });
        return;
      }
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const prompt = (body.prompt || "").trim();
      if (!prompt) { json(res, 400, { error: "prompt required" }); return; }

      const user = body.user || "web";
      const baseBranch = body.base_branch || DEFAULT_BASE_BRANCH;
      const name = (body.name || "").trim();
      const profile = (body.profile || "").trim();

      console.log(`[HTTP] POST /api/sessions user=${user} branch=${baseBranch}${profile ? ` profile=${profile}` : ""} prompt=${truncate(prompt, 80)}`);

      let responded = false;
      docker.runContainerSession({
        prompt,
        userName: user,
        targetRef: `origin/${baseBranch}`,
        profile: profile || undefined,
      }, store, undefined, (logUrl, worktreeId) => {
        if (name) store.setWorktreeName(worktreeId, name);
        if (!responded) {
          responded = true;
          json(res, 202, { ok: true, log_url: logUrl, worktree_id: worktreeId });
        }
      }).catch((e) => {
        console.error(`[HTTP] Session error: ${e}`);
        if (!responded) {
          responded = true;
          json(res, 500, { ok: false, message: e.message });
        }
      });
    },
  },

  // POST /s/<id>/name — rename a workspace
  {
    method: "POST", pattern: /^\/s\/([a-f0-9][\w-]+)\/name$/, auth: "basic",
    handler: async (req, res, params, { store }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved) { json(res, 404, { ok: false, message: "Not found" }); return; }
      let body: any;
      try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "invalid JSON" }); return; }
      const name = (body.name || "").trim();
      if (!name) { json(res, 400, { ok: false, message: "name required" }); return; }
      store.setWorktreeName(resolved.worktreeId, name);
      json(res, 200, { ok: true });
    },
  },

  // POST /s/<id>/resolve — mark workspace as resolved/unresolved
  {
    method: "POST", pattern: /^\/s\/([a-f0-9][\w-]+)\/resolve$/, auth: "basic",
    handler: async (req, res, params, { store }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved) { json(res, 404, { ok: false, message: "Not found" }); return; }
      let body: any;
      try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "invalid JSON" }); return; }
      store.setWorktreeResolved(resolved.worktreeId, !!body.resolved);
      json(res, 200, { ok: true });
    },
  },

  // DELETE /s/<id> — delete a workspace to free disk space
  {
    method: "DELETE", pattern: /^\/s\/([a-f0-9][\w-]+)$/, auth: "basic",
    handler: async (_req, res, params, { store }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved) { json(res, 404, { ok: false, message: "Not found" }); return; }
      // Don't delete if running
      if (resolved.session.status === "running") {
        json(res, 409, { ok: false, message: "Cannot delete while session is running" });
        return;
      }
      store.deleteWorktree(resolved.worktreeId);
      json(res, 200, { ok: true });
    },
  },

  // POST /s/<id>/cancel — cancel session (JSON response)
  {
    method: "POST", pattern: /^\/s\/([a-f0-9][\w-]+)\/cancel$/, auth: "basic",
    handler: async (_req, res, params, { store, docker }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved) { json(res, 404, { ok: false, message: "Session not found" }); return; }
      const cancelled = docker.cancelSession(params[0], resolved.session, store);
      json(res, 200, { ok: cancelled, message: cancelled ? "Session cancelled" : "Session was already stopped" });
    },
  },

  // GET /api/audit/questions — list questions from local question store
  {
    method: "GET", pattern: /^\/api\/audit\/questions$/, auth: "basic",
    handler: async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      const status = url.searchParams.get("state") || url.searchParams.get("status") || undefined;
      const worktreeId = url.searchParams.get("worktree_id") || undefined;
      const questionStore = new QuestionStore();
      if (worktreeId) {
        json(res, 200, questionStore.getQuestions(worktreeId, status === "all" ? undefined : status));
      } else {
        json(res, 200, questionStore.getAll(status === "all" ? undefined : status));
      }
    },
  },

  // GET /api/audit/findings — proxy to GitHub issues API for audit-finding issues
  {
    method: "GET", pattern: /^\/api\/audit\/findings$/, auth: "basic",
    handler: async (req, res) => {
      if (!GH_TOKEN) { json(res, 500, { error: "No GH_TOKEN configured" }); return; }
      const url = new URL(req.url || "/", "http://localhost");
      const state = url.searchParams.get("state") || "all";
      const ghRes = await fetch(
        `https://api.github.com/repos/AztecProtocol/barretenberg-claude/issues?labels=audit-finding&state=${state}&per_page=50&sort=updated`,
        { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" } },
      );
      const data = await ghRes.json();
      json(res, ghRes.status, data);
    },
  },

  // GET /api/audit/assessments — read audit_assessment.jsonl stats
  {
    method: "GET", pattern: /^\/api\/audit\/assessments$/, auth: "basic",
    handler: async (_req, res) => {
      const statsDir = process.env.CLAUDEBOX_STATS_DIR || `${process.env.HOME}/.claudebox/stats`;
      const file = join(statsDir, "audit_assessment.jsonl");
      if (!existsSync(file)) { json(res, 200, []); return; }
      const entries = readFileSync(file, "utf-8")
        .split("\n").filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      json(res, 200, entries);
    },
  },

  // GET /api/audit/coverage — file review coverage stats with local repo totals + quality dimensions
  {
    method: "GET", pattern: /^\/api\/audit\/coverage$/, auth: "basic",
    handler: async (_req, res) => {
      const statsDir = process.env.CLAUDEBOX_STATS_DIR || `${process.env.HOME}/.claudebox/stats`;

      function readJsonl(filename: string): any[] {
        const f = join(statsDir, filename);
        if (!existsSync(f)) return [];
        const entries: any[] = [];
        readFileSync(f, "utf-8").split("\n").filter(l => l.trim()).forEach(l => {
          try { entries.push(JSON.parse(l)); } catch {}
        });
        return entries;
      }

      const reviews = readJsonl("audit_file_review.jsonl");
      const summaries = readJsonl("audit_summary.jsonl");
      const artifacts = readJsonl("audit_artifact.jsonl");

      // Dedupe files — keep deepest review per (file_path, dimension)
      const depthOrder: Record<string, number> = { cursory: 0, "line-by-line": 1, deep: 2 };
      const dims = ["code", "crypto", "test", "crypto-2nd-pass"];

      // Also keep a flat dedup (any dimension) for backward compat
      const byFile = new Map<string, any>();
      const byFileDim = new Map<string, any>(); // key: "path::dim"
      for (const r of reviews) {
        const dim = r.quality_dimension || "code";

        // Flat dedup (deepest across all dimensions)
        const existingFlat = byFile.get(r.file_path);
        if (!existingFlat || (depthOrder[r.review_depth] ?? 0) > (depthOrder[existingFlat.review_depth] ?? 0)) {
          byFile.set(r.file_path, r);
        }

        // Per-dimension dedup
        const key = `${r.file_path}::${dim}`;
        const existingDim = byFileDim.get(key);
        if (!existingDim || (depthOrder[r.review_depth] ?? 0) > (depthOrder[existingDim.review_depth] ?? 0)) {
          byFileDim.set(key, { ...r, quality_dimension: dim });
        }
      }

      // Scan local barretenberg repo for total file counts per module
      const repoDir = process.env.CLAUDE_REPO_DIR || join(process.env.HOME || "", "repo");
      const bbSrcDir = join(repoDir, "barretenberg/cpp/src/barretenberg");
      const moduleTotals = new Map<string, string[]>();
      function scanDir(dir: string, relBase: string) {
        try {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            const rel = relBase ? `${relBase}/${entry}` : entry;
            try {
              const st = statSync(full);
              if (st.isDirectory()) scanDir(full, rel);
              else if (entry.endsWith(".hpp") || entry.endsWith(".cpp")) {
                const mod = relBase.split("/")[0] || "root";
                if (!moduleTotals.has(mod)) moduleTotals.set(mod, []);
                moduleTotals.get(mod)!.push(`barretenberg/cpp/src/barretenberg/${rel}`);
              }
            } catch {}
          }
        } catch {}
      }
      if (existsSync(bbSrcDir)) scanDir(bbSrcDir, "");

      // Group reviews by module (flat)
      const byModule = new Map<string, { files: any[], issues: number }>();
      for (const r of byFile.values()) {
        const mod = r.module || "unknown";
        if (!byModule.has(mod)) byModule.set(mod, { files: [], issues: 0 });
        const m = byModule.get(mod)!;
        m.files.push(r);
        m.issues += r.issues_found || 0;
      }

      // Group reviews by module + dimension
      type DimData = { files: any[], issues: number };
      const byModuleDim = new Map<string, Record<string, DimData>>();
      for (const r of byFileDim.values()) {
        const mod = r.module || "unknown";
        const dim = r.quality_dimension || "code";
        if (!byModuleDim.has(mod)) byModuleDim.set(mod, {});
        const modData = byModuleDim.get(mod)!;
        if (!modData[dim]) modData[dim] = { files: [], issues: 0 };
        modData[dim].files.push(r);
        modData[dim].issues += r.issues_found || 0;
      }

      // Build module response
      const allModules = new Set([...byModule.keys(), ...moduleTotals.keys()]);
      let totalRepoFiles = 0;
      for (const files of moduleTotals.values()) totalRepoFiles += files.length;

      const moduleData: Record<string, any> = {};
      for (const mod of [...allModules].sort()) {
        const reviewed = byModule.get(mod);
        const total = moduleTotals.get(mod);
        const dimData = byModuleDim.get(mod) || {};

        const dimensions: Record<string, any> = {};
        for (const dim of dims) {
          const d = dimData[dim];
          dimensions[dim] = {
            files_reviewed: d?.files.length || 0,
            issues_found: d?.issues || 0,
            files: (d?.files || []).map((f: any) => ({
              file_path: f.file_path,
              review_depth: f.review_depth,
              issues_found: f.issues_found,
              notes: f.notes || "",
              ts: f._ts,
              session: f._log_id,
            })),
          };
        }

        moduleData[mod] = {
          total_files: total?.length || 0,
          files_reviewed: reviewed?.files.length || 0,
          issues_found: reviewed?.issues || 0,
          dimensions,
          files: (reviewed?.files || []).map((f: any) => ({
            file_path: f.file_path,
            review_depth: f.review_depth,
            issues_found: f.issues_found,
            notes: f.notes || "",
            ts: f._ts,
            session: f._log_id,
          })),
        };
      }

      // Dimension totals
      const dimensionTotals: Record<string, { files: number, issues: number }> = {};
      for (const dim of dims) {
        let files = 0, issues = 0;
        for (const modData of byModuleDim.values()) {
          if (modData[dim]) { files += modData[dim].files.length; issues += modData[dim].issues; }
        }
        dimensionTotals[dim] = { files, issues };
      }

      json(res, 200, {
        total_repo_files: totalRepoFiles,
        total_reviewed: byFile.size,
        total_reviews: reviews.length,
        modules: moduleData,
        dimension_totals: dimensionTotals,
        artifacts: {
          issues: { open: 0, closed: 0, total: artifacts.filter(a => a.artifact_type === "issue").length },
          prs: { total: artifacts.filter(a => a.artifact_type === "pr").length },
          gists: artifacts.filter(a => a.artifact_type === "gist").length,
        },
        summaries: summaries.map(s => ({
          gist_url: s.gist_url,
          modules_covered: s.modules_covered,
          files_reviewed: s.files_reviewed,
          issues_filed: s.issues_filed,
          summary: s.summary,
          ts: s._ts,
          session: s._log_id,
        })),
      });
    },
  },

  // POST /api/audit/questions/:id/answer — answer a single question from the local store
  {
    method: "POST", pattern: /^\/api\/audit\/questions\/([a-f0-9-]+)\/answer$/, auth: "basic",
    handler: async (req, res, params, { store, docker }) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const questionId = params[0];
      const selectedOption = body.selected_option;
      const freeformAnswer = body.freeform_answer || "";
      const answeredBy = body.answered_by || "web";

      if (!selectedOption) { json(res, 400, { error: "selected_option required" }); return; }

      const questionStore = new QuestionStore();

      // Find which worktree this question belongs to
      const allQuestions = questionStore.getAll();
      const target = allQuestions.find(q => q.id === questionId);
      if (!target) { json(res, 404, { error: `Question ${questionId} not found` }); return; }

      const ok = questionStore.answerQuestion(target.worktree_id, questionId, selectedOption, freeformAnswer, answeredBy);
      if (!ok) { json(res, 409, { error: "Question already answered or expired" }); return; }

      // Check if all questions for this worktree are now resolved
      const allResolved = questionStore.allResolved(target.worktree_id);
      let resumed = false;

      if (allResolved) {
        // Auto-resume the session (fire-and-forget — don't block the HTTP response)
        const session = store.findByWorktreeId(target.worktree_id);
        if (session && session.status !== "running" && store.isWorktreeAlive(target.worktree_id) && getActiveSessions() < MAX_CONCURRENT) {
          const resumePrompt = questionStore.buildResumePrompt(target.worktree_id);
          resumed = true;
          docker.runContainerSession({
            prompt: resumePrompt,
            userName: session.user || "auto-resume",
            worktreeId: target.worktree_id,
            targetRef: session.base_branch ? `origin/${session.base_branch}` : undefined,
            profile: session.profile || undefined,
          }, store).then(() => {
            console.log(`[QUESTIONS] Auto-resumed session completed for worktree ${target.worktree_id}`);
          }).catch(e => {
            console.error(`[QUESTIONS] Auto-resume failed for ${target.worktree_id}: ${e.message}`);
          });
        }
      }

      // Push updated question files to questions branch (fire-and-forget)
      if (GH_TOKEN) {
        questionStore.pushToQuestionsBranch(target.worktree_id, "AztecProtocol/barretenberg-claude", GH_TOKEN).catch(e => {
          console.error(`[QUESTIONS] Failed to push to questions branch: ${e.message}`);
        });
      }

      json(res, 200, { ok: true, all_resolved: allResolved, resumed, worktree_id: target.worktree_id });
    },
  },

  // POST /api/audit/questions/direction — set freeform direction for a worktree's question batch
  {
    method: "POST", pattern: /^\/api\/audit\/questions\/direction$/, auth: "basic",
    handler: async (req, res) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const { worktree_id, text, author } = body;
      if (!worktree_id || !text) { json(res, 400, { error: "worktree_id and text required" }); return; }

      const questionStore = new QuestionStore();
      questionStore.setDirection(worktree_id, text, author || "web");
      json(res, 200, { ok: true });
    },
  },

  // GET /me — personal dashboard
  {
    method: "GET", pattern: /^\/me$/, auth: "none",
    handler: async (_req, res) => {
      html(res, 200, personalDashboardHTML());
    },
  },

  // GET /tagged — sessions grouped by tag
  {
    method: "GET", pattern: /^\/tagged$/, auth: "none",
    handler: async (_req, res) => {
      html(res, 200, taggedDashboardHTML());
    },
  },

  // GET /api/tag-categories — tag categories from all loaded plugins
  {
    method: "GET", pattern: /^\/api\/tag-categories$/, auth: "basic",
    handler: async (_req, res) => {
      const categories = await getAllTagCategories();
      json(res, 200, { categories });
    },
  },

  // GET /api/me/sessions — sessions for a specific user, grouped by channel/thread
  {
    method: "GET", pattern: /^\/api\/me\/sessions$/, auth: "basic",
    handler: async (_req, res, _params, { store }) => {
      const all = store.listAll();

      // Collect unique channel IDs and resolve names
      const channelIds = new Set<string>();
      for (const s of all) {
        if (s.slack_channel) channelIds.add(s.slack_channel);
      }
      // Channel names resolved from static cache via getSlackChannelInfo()

      // Group by worktree first (like buildDashboardData), then enrich
      const worktreeMap = new Map<string, SessionMeta[]>();
      for (const s of all) {
        const key = s.worktree_id || `_single_${s._log_id}`;
        if (!worktreeMap.has(key)) worktreeMap.set(key, []);
        worktreeMap.get(key)!.push(s);
      }

      const enriched: EnrichedWorkspace[] = [];
      for (const [_key, sessions] of worktreeMap) {
        const latest = sessions[0]; // newest run
        const oldest = sessions[sessions.length - 1]; // original session
        const worktreeId = latest.worktree_id || latest._log_id || "";
        const channelId = (oldest || latest).slack_channel || "";
        const info = getSlackChannelInfo(channelId);
        const channelName = (info?.isDm ? "DM" : info?.name) || (oldest || latest).slack_channel_name || "";
        const meta = worktreeId && latest.worktree_id ? store.getWorktreeMeta(worktreeId) : {};

        // Extract artifacts and latest response from activity
        let latestResponse = "";
        const artifactMap = new Map<string, Artifact>(); // dedup by URL
        if (latest.worktree_id) {
          const activity = store.readActivity(latest.worktree_id); // newest first
          for (const a of activity) {
            if (a.type === "response" && !latestResponse) {
              latestResponse = a.text.length > 600 ? a.text.slice(0, 600) + "..." : a.text;
            }
            if (a.type === "artifact") {
              const urlMatch = a.text.match(/(https?:\/\/[^\s)>\]]+)/);
              if (urlMatch) {
                const url = urlMatch[1].replace(/[.,;:!?]+$/, '');
                if (!artifactMap.has(url)) {
                  const prMatch = url.match(/\/pull\/(\d+)/);
                  const issueMatch = url.match(/\/issues\/(\d+)/);
                  const type = url.includes("gist.github") ? "gist" : prMatch ? "pr" : issueMatch ? "issue" : "link";
                  const label = prMatch ? `#${prMatch[1]}` : issueMatch ? `#${issueMatch[1]}` : type === "gist" ? "gist" : "link";
                  artifactMap.set(url, { type, text: label, url });
                }
              }
            }
          }
        }
        const artifacts = [...artifactMap.values()];

        const tags = latest.worktree_id ? store.getWorktreeTags(latest.worktree_id) : [];

        enriched.push({
          worktreeId,
          name: meta.name || null,
          resolved: !!meta.resolved,
          alive: latest.worktree_id ? store.isWorktreeAlive(latest.worktree_id) : false,
          status: latest.status || "unknown",
          exitCode: latest.exit_code ?? null,
          user: latest.user || "unknown",
          prompt: (oldest.prompt || latest.prompt || "").slice(0, 200),
          started: oldest.started || latest.started || null,
          baseBranch: latest.base_branch || "next",
          channelName,
          runCount: sessions.length,
          profile: latest.profile || "",
          latestResponse,
          artifacts,
          tags,
          threadTs: latest.slack_thread_ts || "",
          channelId,
        });
      }

      // Group by channel, then by thread
      const channelMap = new Map<string, { info: SlackChannelInfo; threads: Map<string, EnrichedWorkspace[]> }>();
      // Also collect ungrouped (no channel)
      const ungrouped: EnrichedWorkspace[] = [];

      for (const ws of enriched) {
        if (!ws.channelId) { ungrouped.push(ws); continue; }
        if (!channelMap.has(ws.channelId)) {
          channelMap.set(ws.channelId, {
            info: channelNameMap.get(ws.channelId) || { name: ws.channelId, isDm: false },
            threads: new Map(),
          });
        }
        const threadKey = ws.threadTs || `_no_thread_${ws.worktreeId}`;
        const ch = channelMap.get(ws.channelId)!;
        if (!ch.threads.has(threadKey)) ch.threads.set(threadKey, []);
        ch.threads.get(threadKey)!.push(ws);
      }

      const groups: ChannelGroup[] = [];
      for (const [channelId, { info, threads }] of channelMap) {
        const threadGroups: ThreadGroup[] = [];
        for (const [threadTs, workspaces] of threads) {
          threadGroups.push({
            threadTs,
            firstPrompt: workspaces[workspaces.length - 1]?.prompt || "",
            workspaces,
          });
        }
        // Sort threads: most recently active first
        threadGroups.sort((a, b) => {
          const aTs = a.workspaces[0]?.started || "";
          const bTs = b.workspaces[0]?.started || "";
          return bTs.localeCompare(aTs);
        });
        groups.push({
          channel: info.isDm ? "DM" : info.name,
          channelId,
          threads: threadGroups,
        });
      }

      // Sort channels: most recently active first
      groups.sort((a, b) => {
        const aTs = a.threads[0]?.workspaces[0]?.started || "";
        const bTs = b.threads[0]?.workspaces[0]?.started || "";
        return bTs.localeCompare(aTs);
      });

      // Add ungrouped as a pseudo-channel
      if (ungrouped.length) {
        groups.push({
          channel: "Other",
          channelId: "",
          threads: [{ threadTs: "", firstPrompt: "", workspaces: ungrouped }],
        });
      }

      json(res, 200, { groups, flat: enriched });
    },
  },

  // POST /api/me/tag — generate tags for a worktree using Haiku
  {
    method: "POST", pattern: /^\/api\/me\/tag$/, auth: "basic",
    handler: async (req, res, _params, { store }) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const worktreeId = body.worktree_id;
      if (!worktreeId) { json(res, 400, { error: "worktree_id required" }); return; }

      // Check if already tagged
      const existing = store.getWorktreeTags(worktreeId);
      if (existing.length && !existing.includes("untagged") && !body.force) {
        json(res, 200, { tags: existing, cached: true });
        return;
      }

      const session = store.findByWorktreeId(worktreeId);
      const prompt = session?.prompt || "";
      if (!prompt) { json(res, 200, { tags: [], cached: false }); return; }

      const results = await tagBatch([{ id: worktreeId, prompt }], store.allTags());
      const tags = results.get(worktreeId) || [];
      store.setWorktreeTags(worktreeId, tags);
      json(res, 200, { tags, cached: false });
    },
  },

  // POST /s/<id>/resume — start a new Claude session in the same worktree
  {
    method: "POST", pattern: /^\/s\/([a-f0-9][\w-]+)\/resume$/, auth: "basic",
    handler: async (req, res, params, { store, docker }) => {
      const resolved = resolveSession(params[0], store);
      if (!resolved) { json(res, 404, { ok: false, message: "Session not found" }); return; }
      const { session } = resolved;
      if (session.status === "running") { json(res, 409, { ok: false, message: "Session is still running" }); return; }
      if (!session.worktree_id) { json(res, 400, { ok: false, message: "No worktree to resume" }); return; }
      if (!store.isWorktreeAlive(session.worktree_id)) { json(res, 400, { ok: false, message: "Workspace has been deleted" }); return; }
      if (getActiveSessions() >= MAX_CONCURRENT) { json(res, 503, { ok: false, message: "At capacity" }); return; }

      let body: any = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      const prompt = body.prompt || "Continue from where you left off.";

      console.log(`[HTTP] POST /s/${params[0]}/resume worktree=${session.worktree_id} prompt=${truncate(prompt, 80)}`);

      let responded = false;
      let capturedLogUrl = "";
      docker.runContainerSession({
        prompt,
        userName: body.user || session.user || "web",
        worktreeId: session.worktree_id,
        slackChannel: session.slack_channel || "",
        slackThreadTs: session.slack_thread_ts || "",
        slackMessageTs: session.slack_message_ts || "",
        targetRef: session.base_branch ? `origin/${session.base_branch}` : undefined,
        profile: session.profile || undefined,
      }, store, undefined, (logUrl) => {
        capturedLogUrl = logUrl;
        if (!responded) {
          responded = true;
          json(res, 202, { ok: true, log_url: logUrl, status: "started" });
        }
      }).then((exitCode) => {
        // Update Slack status on completion (same as Slack-initiated sessions)
        if (session.slack_channel && session.slack_message_ts && capturedLogUrl) {
          const statusSuffix = exitCode === 0 ? "completed" : `error (exit ${exitCode})`;
          updateSlackStatus(
            session.slack_channel, session.slack_message_ts, statusSuffix,
            capturedLogUrl, session.worktree_id!, store, prompt,
          ).catch((e: any) => console.warn(`[WARN] Resume Slack update failed: ${e}`));
        }
      }).catch((e) => {
        console.error(`[HTTP] Resume error: ${e}`);
        if (!responded) {
          responded = true;
          json(res, 500, { ok: false, message: e.message });
        }
      });
    },
  },
  // ── Internal API: Slack proxy (sidecar → server) ──────────────
  {
    method: "POST", pattern: /^\/api\/internal\/slack$/, auth: "api",
    handler: async (req, res) => {
      if (!SLACK_BOT_TOKEN) { json(res, 503, { ok: false, error: "no_slack_token" }); return; }
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const { method, args } = body;
      if (!method || typeof method !== "string") { json(res, 400, { error: "method required" }); return; }

      // Whitelist check
      const ALLOWED_METHODS = new Set(["chat.postMessage", "chat.update", "reactions.add", "conversations.replies", "users.list", "conversations.open"]);
      if (!ALLOWED_METHODS.has(method)) { json(res, 403, { ok: false, error: `blocked: ${method}` }); return; }

      try {
        const READ_METHODS = new Set(["conversations.replies", "users.list"]);
        const isRead = READ_METHODS.has(method);
        const url = isRead
          ? `https://slack.com/api/${method}?${new URLSearchParams(Object.entries(args || {}).map(([k, v]) => [k, String(v)])).toString()}`
          : `https://slack.com/api/${method}`;
        const slackRes = await fetch(url, {
          method: isRead ? "GET" : "POST",
          headers: isRead
            ? { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
            : { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
          ...(!isRead && { body: JSON.stringify(args || {}) }),
        });
        const d = await slackRes.json();
        json(res, 200, d);
      } catch (e: any) {
        console.error(`[HTTP] ${e.message}`); json(res, 500, { ok: false, error: "internal error" });
      }
    },
  },

  // ── Internal API: Root comment update (sidecar → server) ─────
  {
    method: "POST", pattern: /^\/api\/internal\/comment$/, auth: "api",
    handler: async (req, res) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const { status, sections, trackedPRs, otherArtifacts, session } = body;
      const results: string[] = [];

      // Build Slack text from sections
      const buildSlackTextFromSections = () => {
        const parts: string[] = [];
        if (sections?.response) {
          parts.push(sections.response.length > 600 ? sections.response.slice(0, 600) + "…" : sections.response);
        } else if (status) {
          parts.push(status.length > 600 ? status.slice(0, 600) + "…" : status);
        }
        const footer: string[] = [];
        const prLinks = (trackedPRs || []).map((pr: any) => `<${pr.url}|#${pr.num}>`);
        if (prLinks.length) footer.push(prLinks.join(" "));
        const worktreeId = session?.worktree_id;
        const host = session?.host || "claudebox.work";
        if (worktreeId) footer.push(`<https://${host}/s/${worktreeId}|status>`);
        if (footer.length) parts.push(footer.join("  \u2502  "));
        return parts.join("\n");
      };

      // Build GitHub body from sections
      const buildGhBodyFromSections = () => {
        const lines: string[] = [];
        const worktreeId = session?.worktree_id;
        const host = session?.host || "claudebox.work";
        const logUrl = session?.log_url || "";
        const links: string[] = [];
        if (worktreeId) links.push(`[Live status](https://${host}/s/${worktreeId})`);
        if (logUrl) links.push(`[Log](${logUrl})`);
        if (links.length) lines.push(links.join(" · "));
        if (sections?.status) { lines.push(""); lines.push(`**Status:** ${sections.status}`); }
        if (sections?.response) { lines.push(""); lines.push(`**Response:** ${sections.response}`); }
        const prLines = (trackedPRs || []).map((pr: any) => {
          const label = pr.action === "created" ? "Created" : "Updated";
          return `- **${label}** [#${pr.num}: ${pr.title}](${pr.url})`;
        });
        if (prLines.length) { lines.push(""); lines.push("**Pull Requests**"); lines.push(...prLines); }
        if (otherArtifacts?.length) lines.push(...otherArtifacts);
        return lines.join("\n");
      };

      // Update Slack
      if (SLACK_BOT_TOKEN && session?.slack_channel && session?.slack_message_ts) {
        try {
          const r = await fetch("https://slack.com/api/chat.update", {
            method: "POST",
            headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: session.slack_channel, ts: session.slack_message_ts,
              text: buildSlackTextFromSections(),
            }),
          });
          const d = await r.json() as any;
          results.push(d.ok ? "Slack updated" : `Slack: ${d.error}`);
        } catch (e: any) { results.push(`Slack: ${e.message}`); }
      }

      // Update GitHub comment
      if (GH_TOKEN && session?.run_comment_id && session?.repo) {
        try {
          const r = await fetch(
            `https://api.github.com/repos/${session.repo}/issues/comments/${session.run_comment_id}`,
            {
              method: "PATCH",
              headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
              body: JSON.stringify({ body: buildGhBodyFromSections() }),
            });
          results.push(r.ok ? "GitHub updated" : `GitHub: ${r.status}`);
        } catch (e: any) { results.push(`GitHub: ${e.message}`); }
      }

      json(res, 200, { results });
    },
  },

  // ── Internal API: DM author on completion ─────────────────────
  {
    method: "POST", pattern: /^\/api\/internal\/dm$/, auth: "api",
    handler: async (req, res) => {
      if (!SLACK_BOT_TOKEN) { json(res, 200, { ok: false, reason: "no_slack" }); return; }
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const { status, trackedPRs, session } = body;
      if (!session?.user) { json(res, 200, { ok: false, reason: "no_user" }); return; }
      if (session.slack_channel?.startsWith("D")) { json(res, 200, { ok: false, reason: "already_dm" }); return; }

      try {
        const parts: string[] = [];
        const contextLinks: string[] = [];
        if (session.slack_channel && session.slack_thread_ts) {
          const slackDomain = process.env.SLACK_WORKSPACE_DOMAIN || "slack";
          const threadLink = `https://${slackDomain}.slack.com/archives/${session.slack_channel}/p${session.slack_thread_ts.replace(".", "")}`;
          contextLinks.push(`<${threadLink}|thread>`);
        }
        if (session.link) contextLinks.push(`<${session.link}|source>`);

        const prLinks = (trackedPRs || []).map((pr: any) => `<${pr.url}|#${pr.num}>`);
        parts.push((status || "Task done") + (prLinks.length ? ` ${prLinks.join(" ")}` : ""));

        const footer: string[] = [...contextLinks];
        const host = session.host || "claudebox.work";
        if (session.worktree_id) footer.push(`<https://${host}/s/${session.worktree_id}|status>`);
        if (footer.length) parts.push(footer.join(" \u2502 "));

        // Find user
        const searchResp = await fetch("https://slack.com/api/users.list?limit=200", {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        });
        const searchData = await searchResp.json() as any;
        const slackUser = searchData.members?.find((m: any) =>
          m.real_name === session.user || m.name === session.user || m.profile?.display_name === session.user
        );
        if (!slackUser) { json(res, 200, { ok: false, reason: "user_not_found" }); return; }

        // Open DM
        const openResp = await fetch("https://slack.com/api/conversations.open", {
          method: "POST",
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ users: slackUser.id }),
        });
        const openData = await openResp.json() as any;
        if (!openData.ok) { json(res, 200, { ok: false, reason: openData.error }); return; }

        // Send DM
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ channel: openData.channel.id, text: parts.join("\n") }),
        });

        json(res, 200, { ok: true, user: slackUser.id });
      } catch (e: any) {
        console.error(`[HTTP] ${e.message}`); json(res, 500, { ok: false, error: "internal error" });
      }
    },
  },
];

// ── Server factory ──────────────────────────────────────────────

export function createHttpServer(
  store: SessionStore,
  docker: DockerService,
  pluginRuntime?: import("./plugin.ts").PluginRuntime,
  dmRegistry?: import("./dm-registry.ts").DmRegistry,
) {
  const ctx = { store, docker };

  // DM registry routes (only if registry provided)
  const dmRoutes: Route[] = [];
  if (dmRegistry) {
    dmRoutes.push(
      {
        method: "GET", pattern: /^\/api\/dm-registry$/, auth: "api",
        handler: async (_req, res) => {
          json(res, 200, Object.fromEntries(dmRegistry.list()));
        },
      },
      {
        method: "POST", pattern: /^\/api\/dm-registry$/, auth: "api",
        handler: async (req, res) => {
          let body: any;
          try { body = JSON.parse(await readBody(req)); }
          catch { json(res, 400, { error: "invalid JSON" }); return; }
          const { user_id, server_url, token, label } = body;
          if (!user_id || !server_url) { json(res, 400, { error: "user_id and server_url required" }); return; }
          dmRegistry.register(user_id, {
            serverUrl: server_url,
            token: token || undefined,
            label: label || undefined,
            registeredAt: new Date().toISOString(),
          });
          json(res, 200, { ok: true, user_id });
        },
      },
      {
        method: "DELETE", pattern: /^\/api\/dm-registry\/([A-Z0-9]+)$/, auth: "api",
        handler: async (_req, res, params) => {
          const userId = params[0];
          const removed = dmRegistry.unregister(userId);
          json(res, 200, { ok: true, removed });
        },
      },
    );
  }

  // Adapt plugin routes into internal Route format
  const allRoutes: Route[] = [...routes, ...dmRoutes];
  if (pluginRuntime) {
    for (const pr of pluginRuntime.getRoutes()) {
      // Convert Express-style path to regex: "/audit/coverage" → /^\/audit\/coverage$/
      // Handle :param patterns: "/questions/:id/answer" → /^\/questions\/([^/]+)\/answer$/
      const paramNames: string[] = [];
      const regexStr = pr.path.replace(/:([a-zA-Z_]+)/g, (_m, name) => {
        paramNames.push(name);
        return "([^/]+)";
      }).replace(/\//g, "\\/");
      allRoutes.push({
        method: pr.method,
        pattern: new RegExp(`^${regexStr}$`),
        auth: pr.auth,
        paramNames,
        handler: async (req, res, params) => pr.handler({ req, res, params, store, docker }),
      });
    }
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Strip query string so route patterns don't need to account for ?key=val
    const pathname = (req.url || "/").split("?")[0];
    for (const route of allRoutes) {
      if (req.method !== route.method) continue;
      const m = pathname.match(route.pattern);
      if (!m) continue;

      // Auth check
      if (route.auth === "api" && !checkApiAuth(req)) { sendUnauthorized(res, "api"); return; }
      if (route.auth === "basic" && !(await checkSessionAuth(req))) { sendUnauthorized(res, "session"); return; }

      // Extract regex groups as params (use named keys from plugin routes, numeric otherwise)
      const params: Record<string, string> = {};
      for (let i = 1; i < m.length; i++) {
        params[i - 1] = m[i];
        if (route.paramNames?.[i - 1]) params[route.paramNames[i - 1]] = m[i];
      }

      try {
        await route.handler(req, res, params, ctx);
      } catch (e: any) {
        console.error(`[HTTP] Route error: ${e.message}`);
        if (!res.headersSent) json(res, 500, { error: "internal error" });
      }
      return;
    }

    json(res, 404, { error: "not found" });
  });
}
