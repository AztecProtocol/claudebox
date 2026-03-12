import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { createHmac, timingSafeEqual } from "crypto";
import { API_SECRET, SESSION_PAGE_USER, SESSION_PAGE_PASS, MAX_CONCURRENT, DEFAULT_BASE_BRANCH, GITHUB_WEBHOOK_SECRET } from "./config.ts";
import { getActiveSessions, getChannelBranches } from "./runtime.ts";
import { getHostCreds } from "../libcreds-host/index.ts";
import { dmAuthor } from "../libcreds-host/slack.ts";
import { existsSync, readFileSync, readdirSync, statSync, watch, mkdirSync, openSync, readSync, fstatSync, closeSync } from "fs";
import { join } from "path";
import type { WorktreeStore } from "./worktree-store.ts";
import type { DockerService } from "./docker.ts";
import type { RunMeta, Artifact, EnrichedWorkspace, ThreadGroup, ChannelGroup } from "./types.ts";
import { workspacePageHTML, dashboardHTML, auditDashboardHTML, personalDashboardHTML, type WorkspaceCard } from "./html/templates.ts";
import { parseMessage, parseKeywords, validateResumeSession, truncate, prKeyFromUrl, sessionUrl } from "./util.ts";
import { updateSlackStatus } from "./slack/helpers.ts";
import { discoverProfiles } from "./profile-loader.ts";

// ── Helpers ─────────────────────────────────────────────────────

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
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
  isDm: boolean;  // DM or MPIM (group DM)
}
const channelInfoCache = new Map<string, SlackChannelInfo>();

// Thread context cache (channel:ts → messages)
const threadCache = new Map<string, any[]>();

// Slack user ID → display name cache
const userNameCache = new Map<string, string>();

async function resolveSlackUser(userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  if (!SLACK_BOT_TOKEN || !userId || userId === "unknown") return userId;
  try {
    const resp = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { "Authorization": `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const data = await resp.json() as any;
    const name = data.ok ? (data.user?.profile?.display_name || data.user?.real_name || data.user?.name || userId) : userId;
    userNameCache.set(userId, name);
    return name;
  } catch { userNameCache.set(userId, userId); return userId; }
}

function getSlackChannelInfo(channelId: string): SlackChannelInfo | null {
  if (channelInfoCache.has(channelId)) return channelInfoCache.get(channelId)!;
  if (channelId.startsWith("D")) return { name: "", isDm: true };
  return null; // unknown channel — no info
}

/** Resolve channel info via Slack API and cache it. */
async function resolveSlackChannelInfo(channelId: string): Promise<SlackChannelInfo | null> {
  if (channelInfoCache.has(channelId)) return channelInfoCache.get(channelId)!;
  if (channelId.startsWith("D")) { const info = { name: "", isDm: true }; channelInfoCache.set(channelId, info); return info; }
  if (!SLACK_BOT_TOKEN || !channelId) return null;
  try {
    const resp = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
      headers: { "Authorization": `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const data = await resp.json() as any;
    if (data.ok) {
      const ch = data.channel || {};
      const isDm = !!ch.is_im || !!ch.is_mpim;
      const info: SlackChannelInfo = { name: ch.name || "", isDm };
      channelInfoCache.set(channelId, info);
      return info;
    }
  } catch {}
  return null;
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

async function buildDashboardData(store: WorktreeStore, profileFilter?: string): Promise<WorkspaceCard[]> {
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
  await Promise.all([...channelIds].map(async (id) => {
    const info = await resolveSlackChannelInfo(id);
    if (info) channelInfoMap.set(id, info);
  }));

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
    } else if (link && /\.slack\.com\//.test(link)) {
      origin = "slack";
    } else if (link) {
      origin = "github";
    }

    // Extract artifacts, latest reply, and last status text from activity
    let lastReply = "";
    let statusText = "";
    const artifactMap = new Map<string, { type: string; text: string; url: string }>();
    if (worktreeId) {
      const activity = store.readActivity(worktreeId); // newest first
      for (const a of activity) {
        if (a.type === "response" && !lastReply) {
          lastReply = a.text.length > 300 ? a.text.slice(0, 300) + "..." : a.text;
        }
        if (a.type === "status" && !statusText) {
          statusText = a.text.length > 120 ? a.text.slice(0, 120) + "..." : a.text;
        }
        if (a.type === "artifact") {
          const urlMatch = a.text.match(/(https?:\/\/[^\s)>\]]+)/);
          if (urlMatch) {
            const url = urlMatch[1].replace(/[.,;:!?]+$/, '');
            if (!artifactMap.has(url)) {
              const prMatch = url.match(/\/pull\/(\d+)/);
              const issueMatch = url.match(/\/issues\/(\d+)/);
              const type = url.includes("gist.github") ? "gist" : prMatch ? "pr" : issueMatch ? "issue" : "link";
              const label = prMatch ? `PR #${prMatch[1]}` : issueMatch ? `Issue #${issueMatch[1]}` : type === "gist" ? "gist" : "link";
              artifactMap.set(url, { type, text: label, url });
            }
          }
        }
      }
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
      slackChannel: slackChannel || undefined,
      slackThreadTs: slackThread || undefined,
      link: link || undefined,
      statusText: statusText || undefined,
      lastReply: lastReply || undefined,
      artifacts: artifactMap.size > 0 ? [...artifactMap.values()] : undefined,
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
function resolveSession(param: string, store: WorktreeStore): { worktreeId: string; session: RunMeta } | null {
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
  ctx: { store: WorktreeStore; docker: DockerService },
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  auth: "api" | "basic" | "none";
  internal?: boolean;
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

      // ── Resolve Slack context from prior session or body ──
      const slackChannel = body.slack_channel || resumedSession?.slack_channel || "";
      const slackThreadTs = body.slack_thread_ts || resumedSession?.slack_thread_ts || "";
      let slackMessageTs = "";
      let slackChannelName = resumedSession?.slack_channel_name || "";

      if (slackChannel && slackThreadTs && SLACK_BOT_TOKEN) {
        try {
          const slackResp = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { "Authorization": `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ channel: slackChannel, thread_ts: slackThreadTs, text: "ClaudeBox starting\u2026" }),
          });
          const slackData = await slackResp.json() as any;
          if (slackData.ok) slackMessageTs = slackData.ts || "";
          if (!slackChannelName) {
            const info = await resolveSlackChannelInfo(slackChannel);
            slackChannelName = info?.name || "";
          }
          console.log(`[HTTP] Posted Slack reply in ${slackChannel} thread=${slackThreadTs} ts=${slackMessageTs}`);
        } catch (e: any) {
          console.warn(`[HTTP] Slack post failed: ${e.message}`);
        }
      }

      let responded = false;
      let capturedWorktreeId = "";
      let capturedLogUrl = "";
      const finalPrompt = parsed?.type === "reply-hash" ? parsed.prompt : prompt;

      docker.runContainerSession({
        prompt: finalPrompt,
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
        ...(slackChannel && slackMessageTs ? {
          slackChannel,
          slackChannelName,
          slackThreadTs,
          slackMessageTs,
        } : {}),
      }, store, undefined, (logUrl, newWorktreeId) => {
        capturedWorktreeId = newWorktreeId;
        capturedLogUrl = logUrl;
        if (prKey) store.bindPr(prKey, newWorktreeId);
        if (slackChannel && slackThreadTs) store.bindThread(slackChannel, slackThreadTs, newWorktreeId);
        // Update Slack message with working status
        if (slackMessageTs && SLACK_BOT_TOKEN) {
          fetch("https://slack.com/api/chat.update", {
            method: "POST",
            headers: { "Authorization": `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ channel: slackChannel, ts: slackMessageTs, text: `_working\u2026_ <${sessionUrl(newWorktreeId)}|status>` }),
          }).catch(() => {});
        }
        if (!responded) {
          responded = true;
          json(res, 202, { log_url: logUrl, worktree_id: newWorktreeId, status: "started" });
        }
      }).then((exitCode) => {
        // On completion, update Slack status like Slack-originated sessions
        if (slackMessageTs && slackChannel && capturedLogUrl) {
          const latestSession = capturedWorktreeId ? store.findByWorktreeId(capturedWorktreeId) : null;
          const capturedLogId = latestSession?._log_id || "";
          const statusSuffix = exitCode === 0 ? "completed" : `error (exit ${exitCode})`;
          updateSlackStatus(slackChannel, slackMessageTs, statusSuffix, capturedLogUrl, capturedWorktreeId, store, finalPrompt, capturedLogId)
            .catch((e) => console.warn(`[WARN] Slack status update failed: ${e}`));
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

  // POST /api/github/webhook — GitHub webhook for label-triggered reviews
  {
    method: "POST", pattern: /^\/api\/github\/webhook$/, auth: "none",
    handler: async (req, res, _params, { store, docker }) => {
      const event = req.headers["x-github-event"] as string;
      const sig = req.headers["x-hub-signature-256"] as string;
      const rawBody = await readBody(req);

      // Verify HMAC signature
      if (GITHUB_WEBHOOK_SECRET) {
        if (!sig) { json(res, 401, { error: "missing signature" }); return; }
        const expected = "sha256=" + createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(rawBody).digest("hex");
        if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          json(res, 401, { error: "invalid signature" });
          return;
        }
      }

      // Only process pull_request labeled events
      if (event !== "pull_request") { json(res, 200, { ignored: true, reason: `event=${event}` }); return; }

      let payload: any;
      try { payload = JSON.parse(rawBody); } catch { json(res, 400, { error: "invalid JSON" }); return; }

      if (payload.action !== "labeled") { json(res, 200, { ignored: true, reason: `action=${payload.action}` }); return; }

      const labelName = payload.label?.name;
      if (labelName !== "claude-review") { json(res, 200, { ignored: true, reason: `label=${labelName}` }); return; }

      const pr = payload.pull_request;
      if (!pr) { json(res, 400, { error: "missing pull_request" }); return; }

      const prNumber = pr.number;
      const prTitle = pr.title || "";
      const prAuthor = pr.user?.login || "unknown";
      const prUrl = pr.html_url || `https://github.com/${payload.repository?.full_name}/pull/${prNumber}`;
      const repo = payload.repository?.full_name || "AztecProtocol/aztec-packages";
      const headRef = pr.head?.ref || "";

      console.log(`[WEBHOOK] claude-review label on ${repo}#${prNumber} "${prTitle}" by ${prAuthor}`);

      // Capacity check
      if (getActiveSessions() >= MAX_CONCURRENT) {
        json(res, 503, { error: "at capacity" });
        return;
      }

      // Dedup: check if a session is already running for this PR
      const prKey = prKeyFromUrl(prUrl);
      if (prKey) {
        const bound = store.getPrBinding(prKey);
        if (bound) {
          const prev = store.findByWorktreeId(bound);
          if (prev?.status === "running") {
            json(res, 409, { error: "review session already running for this PR" });
            return;
          }
        }
      }

      const prompt = `Review PR #${prNumber}: ${prTitle}
${prUrl}

Author: ${prAuthor}
Head branch: ${headRef}

## Instructions

1. Fetch and read the full PR diff, description, and all comments
2. Read any linked or attached issues referenced in the PR body or comments
3. For each changed file, read the FULL file to understand surrounding context
4. Look at recent git history (last 20 commits) for the changed files to understand evolution
5. Check CI status with ci_failures
6. Do a thorough review — assume every line is suspect. Focus on non-obvious bugs:
   - Edge cases (zero values, empty collections, overflow)
   - Concurrency issues (races, missing locks, ordering assumptions)
   - Security (missing validation, injection, unsafe patterns)
   - Correctness (off-by-one, wrong operator, inverted conditions)
   - Compatibility (breaking changes, API drift, constant sync)
7. If you find a clear, direct fix, create a PR with it
8. When done, call manage_review_labels(pr_number=${prNumber}) to swap labels
9. Create a gist with your full review
10. Call respond_to_user with a terse summary + gist link`;

      let responded = false;
      docker.runContainerSession({
        prompt,
        userName: `review/${prAuthor}`,
        link: prUrl,
        targetRef: `origin/${headRef}`,
        profile: "review",
      }, store, undefined, (logUrl, worktreeId) => {
        if (prKey) store.bindPr(prKey, worktreeId);
        if (!responded) {
          responded = true;
          console.log(`[WEBHOOK] Review session started: ${logUrl}`);
          json(res, 202, { ok: true, log_url: logUrl, worktree_id: worktreeId, pr: prNumber });
        }
      }).catch((e) => {
        console.error(`[WEBHOOK] Session error: ${e}`);
        if (!responded) { responded = true; json(res, 500, { error: "internal error" }); }
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
      // If accessed by logId, redirect to worktree URL with ?run= to highlight specific run
      if (worktreeId && params[0] !== worktreeId) {
        res.writeHead(302, { Location: `/s/${worktreeId}?run=${params[0]}` });
        res.end();
        return;
      }

      const hash = session._log_id || params[0];
      const sessions = worktreeId ? store.listByWorktree(worktreeId) : [{ ...session, _log_id: hash }];
      const worktreeAlive = worktreeId ? store.isWorktreeAlive(worktreeId) : false;

      // Extract all replies per session from activity (for run card summaries)
      const lastReplies: Record<string, string> = {};
      if (worktreeId) {
        const activity = store.readActivity(worktreeId); // newest first
        const sessionsOldest = [...sessions].reverse();
        const repliesByRun: Record<string, string[]> = {};
        for (const entry of activity) {
          if (entry.type !== "response") continue;
          let logId: string | undefined;
          if ((entry as any).log_id) {
            logId = (entry as any).log_id;
          } else if (entry.ts) {
            for (let i = sessionsOldest.length - 1; i >= 0; i--) {
              if (sessionsOldest[i].started && entry.ts >= sessionsOldest[i].started) {
                logId = sessionsOldest[i]._log_id;
                break;
              }
            }
          }
          if (logId) {
            if (!repliesByRun[logId]) repliesByRun[logId] = [];
            repliesByRun[logId].push(entry.text);
          }
        }
        // Combine all replies (reversed to chronological order)
        for (const [logId, replies] of Object.entries(repliesByRun)) {
          lastReplies[logId] = replies.reverse().join("\n\n---\n\n");
        }
      }

      // Activity loaded client-side after auth (via SSE) — don't leak in HTML
      html(res, 200, workspacePageHTML({ hash, session, sessions, worktreeAlive, activity: [], lastReplies }));
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
          started: s.started, prompt: s.prompt, user: s.user, log_url: s.log_url, link: s.link || "",
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

      // Send current state as initial event — deduplicate entries caused by
      // cumulative progress events in the session streamer (same type+text+log_id
      // appearing many times within seconds). Uses last-seen timestamp per key;
      // entries >30s apart with the same text are kept (legitimate repeated calls).
      const rawActivity = store.readActivity(worktreeId).reverse(); // oldest first
      const lastSeen = new Map<string, number>();
      const activity = rawActivity.filter(e => {
        const key = `${e.type}|${e.log_id || ""}|${(e.text || "").slice(0, 80)}`;
        const ts = e.ts ? new Date(e.ts).getTime() : 0;
        const prev = lastSeen.get(key);
        lastSeen.set(key, ts);
        if (prev !== undefined && ts && Math.abs(ts - prev) < 30_000) return false;
        return true;
      });
      const currentSession = store.findByWorktreeId(worktreeId);
      let currentLogId = currentSession?._log_id || session._log_id || "";
      res.write(`data: ${JSON.stringify({ type: "init", activity, status: currentSession?.status || "unknown", exit_code: currentSession?.exit_code ?? null })}\n\n`);

      const activityPath = join(store.worktreesDir, worktreeId, "workspace", "activity.jsonl");
      // Track byte offset for incremental reads (avoids re-reading entire file)
      let byteOffset = 0;
      let leftover = "";
      try { if (existsSync(activityPath)) byteOffset = statSync(activityPath).size; } catch {}
      let lastStatus = currentSession?.status || "unknown";
      let lastExitCode = currentSession?.exit_code ?? null;

      // Poll for new lines (fs.watch is unreliable in Docker bind mounts)
      const poll = setInterval(() => {
        try {
          // Read new activity bytes incrementally
          if (existsSync(activityPath)) {
            const fileSize = statSync(activityPath).size;
            if (fileSize > byteOffset) {
              const fd = openSync(activityPath, "r");
              try {
                const buf = Buffer.alloc(fileSize - byteOffset);
                readSync(fd, buf, 0, buf.length, byteOffset);
                byteOffset = fileSize;
                const text = leftover + buf.toString("utf-8");
                const parts = text.split("\n");
                leftover = parts.pop() ?? "";
                for (const line of parts) {
                  if (!line.trim()) continue;
                  try {
                    const entry = JSON.parse(line);
                    res.write(`data: ${JSON.stringify({ type: "activity", entry })}\n\n`);
                    if (entry.type === "name" && entry.text && worktreeId) {
                      store.setWorktreeName(worktreeId, entry.text);
                    }
                  } catch {}
                }
              } finally { closeSync(fd); }
            }
          }

          // Check status — read single session file instead of listing all
          // Also detect if a new session started (e.g., resume)
          const latest = store.get(currentLogId);
          if (latest) {
            const s = latest.status || "unknown";
            const ec = latest.exit_code ?? null;
            if (s !== lastStatus || ec !== lastExitCode) {
              lastStatus = s; lastExitCode = ec;
              res.write(`data: ${JSON.stringify({ type: "status", status: s, exit_code: ec })}\n\n`);
              // If this session ended, check for a newer one (resume)
              if (s !== "running") {
                const newer = store.findByWorktreeId(worktreeId);
                if (newer?._log_id && newer._log_id !== currentLogId) {
                  currentLogId = newer._log_id;
                }
              }
            }
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
      const slackDomain = process.env.SLACK_WORKSPACE_DOMAIN || "";
      json(res, 200, { workspaces, activeCount: getActiveSessions(), maxConcurrent: MAX_CONCURRENT, slackDomain });
    },
  },

  // GET /api/thread?channel=X&ts=Y — fetch Slack thread messages interleaved with sessions
  {
    method: "GET", pattern: /^\/api\/thread$/, auth: "basic",
    handler: async (req, res, _params, { store }) => {
      const url = new URL(req.url || "/", "http://localhost");
      const channel = url.searchParams.get("channel") || "";
      const ts = url.searchParams.get("ts") || "";
      if (!channel || !ts) { json(res, 400, { error: "channel and ts required" }); return; }

      const cacheKey = `${channel}:${ts}`;
      if (threadCache.has(cacheKey)) { json(res, 200, threadCache.get(cacheKey)!); return; }

      if (!SLACK_BOT_TOKEN) { json(res, 200, { entries: [] }); return; }

      try {
        const resp = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${ts}&limit=100`, {
          headers: { "Authorization": `Bearer ${SLACK_BOT_TOKEN}` },
        });
        const data = await resp.json() as any;
        if (!data.ok) { json(res, 200, { entries: [], error: data.error }); return; }

        // Build a map of message_ts → session info for this thread
        const sessionsByMsgTs = new Map<string, any>();
        const threadSessions = store.listAll()
          .filter(s => s.slack_channel === channel && s.slack_thread_ts === ts && s.slack_message_ts);
        // Sort by start time to assign run numbers
        threadSessions.sort((a, b) => (a.started || "").localeCompare(b.started || ""));
        for (let i = 0; i < threadSessions.length; i++) {
          const s = threadSessions[i];
          sessionsByMsgTs.set(s.slack_message_ts!, {
            logId: s._log_id,
            worktreeId: s.worktree_id || s._log_id,
            status: s.status || "unknown",
            exitCode: s.exit_code ?? null,
            name: s.worktree_id ? (store.getWorktreeMeta(s.worktree_id).name || null) : null,
            run: i + 1,
            totalRuns: threadSessions.length,
            prompt: stripSlackContext(s.prompt || ""),
          });
        }

        const slackDomain = process.env.SLACK_WORKSPACE_DOMAIN || "slack";
        const entries: any[] = [];
        for (const m of (data.messages || [])) {
          const isBot = !!m.bot_id || !!m.bot_profile;
          const userName = await resolveSlackUser(m.user || m.bot_id || "unknown");
          // Strip <@USERID> mentions, resolve to names
          let text = (m.text || "");
          const mentionRe = /<@([A-Z0-9]+)>/g;
          const mentions = [...text.matchAll(mentionRe)];
          for (const match of mentions) {
            const resolvedName = await resolveSlackUser(match[1]);
            text = text.replace(match[0], `@${resolvedName}`);
          }
          // Strip <URL|label> slack formatting to just label or URL
          text = text.replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/<([^>]+)>/g, "$1");

          // Slack permalink for this message
          const slackLink = `https://${slackDomain}.slack.com/archives/${channel}/p${(m.ts || "").replace(".", "")}`;

          const entry: any = {
            type: isBot ? "bot" : "user",
            user: userName,
            text: text.slice(0, 1000),
            ts: m.ts,
            slackLink,
          };

          // If this is a bot message, check if it maps to a session
          if (isBot && sessionsByMsgTs.has(m.ts)) {
            entry.session = sessionsByMsgTs.get(m.ts);
          }

          entries.push(entry);
        }

        const result = { entries };
        threadCache.set(cacheKey, result);
        json(res, 200, result);
      } catch (e: any) {
        json(res, 200, { entries: [], error: e.message });
      }
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
      json(res, 200, { profiles: discoverProfiles() });
    },
  },

  // GET /api/tags — all known tags
  {
    method: "GET", pattern: /^\/api\/tags$/, auth: "basic",
    handler: async (_req, res, _params, { store }) => {
      json(res, 200, { tags: store.allTags() });
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


  // GET /api/audit/findings — proxy to GitHub issues API for audit-finding issues
  {
    method: "GET", pattern: /^\/api\/audit\/findings$/, auth: "basic",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || "/", "http://localhost");
        const state = url.searchParams.get("state") || "all";
        const data = await getHostCreds().github.listIssues("AztecProtocol/barretenberg-claude", {
          labels: "audit-finding", state, per_page: "50", sort: "updated",
        });
        json(res, 200, data);
      } catch (e: any) {
        json(res, 500, { error: e.message });
      }
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


  // GET /me — personal dashboard
  {
    method: "GET", pattern: /^\/me$/, auth: "none",
    handler: async (_req, res) => {
      html(res, 200, personalDashboardHTML());
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
      // Resolve channel names (async via Slack API)
      const channelNameMap = new Map<string, SlackChannelInfo>();
      await Promise.all([...channelIds].map(async (id) => {
        const info = await resolveSlackChannelInfo(id);
        if (info) channelNameMap.set(id, info);
      }));

      // Group by worktree first (like buildDashboardData), then enrich
      const worktreeMap = new Map<string, RunMeta[]>();
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
        const info = channelNameMap.get(channelId);
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
                  const label = prMatch ? `PR #${prMatch[1]}` : issueMatch ? `Issue #${issueMatch[1]}` : type === "gist" ? "gist" : "link";
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
    method: "POST", pattern: /^\/api\/internal\/slack$/, auth: "api", internal: true,
    handler: async (req, res) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const { method, args } = body;
      if (!method || typeof method !== "string") { json(res, 400, { error: "method required" }); return; }

      // Whitelist check
      const ALLOWED_METHODS = new Set(["chat.postMessage", "chat.update", "reactions.add", "conversations.replies", "users.list", "conversations.open"]);
      if (!ALLOWED_METHODS.has(method)) { json(res, 403, { ok: false, error: `blocked: ${method}` }); return; }

      try {
        const { getHostCreds } = await import("../libcreds-host/index.ts");
        const creds = getHostCreds({ slackChannel: args?.channel });
        const slack = creds.slack;
        let d: any;
        switch (method) {
          case "chat.postMessage": d = await slack.postMessage(args.text, { channel: args.channel, threadTs: args.thread_ts }); break;
          case "chat.update": d = await slack.updateMessage(args.text, { channel: args.channel, ts: args.ts }); break;
          case "reactions.add": d = await slack.addReaction(args.name, { channel: args.channel, timestamp: args.timestamp }); break;
          case "conversations.replies": d = await slack.getThreadReplies({ channel: args.channel, ts: args.ts, limit: args.limit }); break;
          case "users.list": d = await slack.listUsers(args.limit); break;
          case "conversations.open": d = await slack.openConversation(args.users); break;
          default: json(res, 403, { ok: false, error: `blocked: ${method}` }); return;
        }
        json(res, 200, d);
      } catch (e: any) {
        console.error(`[HTTP] ${e.message}`); json(res, 500, { ok: false, error: "internal error" });
      }
    },
  },

  // ── Internal API: Root comment update (sidecar → server) ─────
  {
    method: "POST", pattern: /^\/api\/internal\/comment$/, auth: "api", internal: true,
    handler: async (req, res, _params, { store }) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const { status, sections, trackedPRs, otherArtifacts, session: sidecarSession } = body;
      const results: string[] = [];

      // Enrich session info from the store — sidecar doesn't have Slack/GitHub metadata
      const logId = sidecarSession?.log_id || "";
      const storedSession = logId ? store.get(logId) : null;
      const session = { ...sidecarSession, ...storedSession };

      const worktreeId = session?.worktree_id;
      const host = session?.host || "claudebox.work";
      const runSeq = session?.log_id?.match(/-(\d+)$/)?.[1] || "";
      const baseUrl = worktreeId ? `https://${host}/s/${worktreeId}${runSeq ? `?run=${runSeq}` : ""}` : "";

      // Build Slack text from sections
      const buildSlackTextFromSections = (elapsedStr?: string) => {
        const parts: string[] = [];
        if (sections?.response) {
          parts.push(sections.response.length > 600 ? sections.response.slice(0, 600) + "…" : sections.response);
        } else if (status) {
          parts.push(status.length > 600 ? status.slice(0, 600) + "…" : status);
        }
        const footer: string[] = [];
        const prLinks = (trackedPRs || []).map((pr: any) => `<${pr.url}|PR #${pr.num}>`);
        if (prLinks.length) footer.push(prLinks.join(" "));
        if (baseUrl) footer.push(`<${baseUrl}|status>`);
        if (elapsedStr) footer.push(elapsedStr);
        if (footer.length) parts.push(footer.join("  \u2502  "));
        return parts.join("\n");
      };

      // Elapsed time since session started
      const elapsed = (() => {
        const started = session?.started;
        if (!started) return "";
        const ms = Date.now() - new Date(started).getTime();
        if (ms < 0) return "";
        const mins = Math.floor(ms / 60000);
        if (mins < 1) return "<1m";
        if (mins < 60) return `${mins}m`;
        return `${Math.floor(mins / 60)}h${mins % 60}m`;
      })();

      // Build GitHub body from sections
      const currentSeq = runSeq;
      const buildGhBodyFromSections = () => {
        const lines: string[] = [];
        const elapsedSuffix = elapsed ? ` (${elapsed})` : "";
        lines.push(`\u23F3 **Run #${currentSeq || "?"}** — ${sections?.status || status || "running"}${elapsedSuffix}`);
        if (baseUrl) lines.push(`[Live status](${baseUrl})`);
        if (sections?.response) { lines.push(""); lines.push(sections.response); }
        const prLines = (trackedPRs || []).map((pr: any) => {
          const label = pr.action === "created" ? "Created" : "Updated";
          return `- **${label}** [PR #${pr.num}: ${pr.title}](${pr.url})`;
        });
        if (prLines.length) { lines.push(""); lines.push(prLines.join("\n")); }
        if (otherArtifacts?.length) lines.push(...otherArtifacts);
        return lines.join("\n");
      };

      // Update Slack
      if (session?.slack_channel && session?.slack_message_ts) {
        try {
          const slackCreds = getHostCreds({ slackChannel: session.slack_channel, slackMessageTs: session.slack_message_ts });
          const d = await slackCreds.slack.updateMessage(buildSlackTextFromSections(elapsed), { channel: session.slack_channel, ts: session.slack_message_ts });
          results.push(d?.ok ? "Slack updated" : `Slack: ${d?.error || "unknown"}`);
        } catch (e: any) { results.push(`Slack: ${e.message}`); }
      }

      // Update GitHub comment
      if (session?.run_comment_id && session?.repo) {
        try {
          await getHostCreds().github.updateIssueComment(session.repo, session.run_comment_id, buildGhBodyFromSections());
          results.push("GitHub updated");
        } catch (e: any) { results.push(`GitHub: ${e.message}`); }
      }

      json(res, 200, { results });
    },
  },

  // ── Internal API: DM author on completion ─────────────────────
  {
    method: "POST", pattern: /^\/api\/internal\/dm$/, auth: "api", internal: true,
    handler: async (req, res, _params, { store }) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      const { status, trackedPRs, session: sidecarSession } = body;
      // Enrich with stored session data (sidecar lacks Slack metadata)
      const logId = sidecarSession?.log_id || "";
      const storedSession = logId ? store.get(logId) : null;
      const session = { ...sidecarSession, ...storedSession };
      try {
        const result = await dmAuthor(session, status, trackedPRs);
        json(res, 200, result);
      } catch (e: any) {
        console.error(`[HTTP] ${e.message}`); json(res, 500, { ok: false, error: "internal error" });
      }
    },
  },

  // ── Internal API: Unified creds proxy (sidecar → server) ──
  {
    method: "POST", pattern: /^\/api\/internal\/creds$/, auth: "api", internal: true,
    handler: async (req, res) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid JSON" }); return; }

      try {
        const { handleCredsEndpoint } = await import("../libcreds-host/index.ts");
        const result = await handleCredsEndpoint(body);
        json(res, result.ok ? 200 : 400, result);
      } catch (e: any) {
        console.error(`[HTTP] ${e.message}`); json(res, 500, { ok: false, error: "internal error" });
      }
    },
  },

  // ── Internal API: CI log read (sidecar → host, host has Redis/SSH) ──
  {
    method: "GET", pattern: /^\/api\/internal\/read-log$/, auth: "api", internal: true,
    handler: async (req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const key = url.searchParams.get("key") || "";
      if (!key || !/^[a-zA-Z0-9._-]+$/.test(key)) { json(res, 400, { error: "invalid key" }); return; }

      try {
        const { spawnSync } = await import("child_process");
        const { gunzipSync } = await import("zlib");
        const redisHost = process.env.CI_REDIS || "localhost";

        // Direct redis GET — no shell, no ci.sh, no untrusted code
        const result = spawnSync("redis-cli", ["--raw", "-h", redisHost, "GET", key], {
          timeout: 15_000, maxBuffer: 50 * 1024 * 1024,
        });
        if (result.status !== 0) {
          json(res, 502, { error: `redis-cli failed: ${(result.stderr || "").toString().trim().slice(0, 300)}`, key });
          return;
        }

        let buf = result.stdout as Buffer;
        // redis-cli --raw appends a trailing newline — strip it before length check
        if (buf && buf.length > 0 && buf[buf.length - 1] === 0x0a) buf = buf.subarray(0, -1);

        if (!buf || buf.length === 0) {
          // Fallback: HTTP log server
          const ciPassword = process.env.CI_PASSWORD;
          if (ciPassword) {
            const resp = await fetch(`http://ci.aztec-labs.com/${key}.txt`, {
              headers: { "Authorization": `Basic ${Buffer.from(`aztec:${ciPassword}`).toString("base64")}` },
            });
            if (resp.ok) {
              res.writeHead(200, { "Content-Type": "text/plain" });
              res.end(await resp.text());
              return;
            }
          }
          json(res, 404, { error: "Key not found", key });
          return;
        }

        // Decompress if gzipped (magic bytes 1f 8b)
        let output: string;
        if (buf[0] === 0x1f && buf[1] === 0x8b) {
          output = gunzipSync(buf).toString("utf-8");
        } else {
          output = buf.toString("utf-8");
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(output);
      } catch (e: any) {
        json(res, 500, { error: e.message });
      }
    },
  },
];

// ── Server factory ──────────────────────────────────────────────

export function createHttpServer(
  store: WorktreeStore,
  docker: DockerService,
  profileRuntime?: import("./profile.ts").ProfileRuntime,
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

  // Adapt profile routes into internal Route format
  const allRoutes: Route[] = [...routes, ...dmRoutes];
  if (profileRuntime) {
    for (const pr of profileRuntime.getRoutes()) {
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

  // Split routes into public (internet-facing) and internal (sidecar-only)
  const publicRoutes = allRoutes.filter(r => !r.internal);
  const internalRoutes = allRoutes.filter(r => r.internal);

  function buildHandler(routeList: Route[]) {
    return async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = (req.url || "/").split("?")[0];
      for (const route of routeList) {
        if (req.method !== route.method) continue;
        const m = pathname.match(route.pattern);
        if (!m) continue;

        if (route.auth === "api" && !checkApiAuth(req)) { sendUnauthorized(res, "api"); return; }
        if (route.auth === "basic" && !(await checkSessionAuth(req))) { sendUnauthorized(res, "session"); return; }

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
    };
  }

  return {
    public: createServer(buildHandler(publicRoutes)),
    internal: createServer(buildHandler(internalRoutes)),
  };
}
