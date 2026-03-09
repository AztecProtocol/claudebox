/**
 * libcreds — Centralized credential management for ClaudeBox.
 *
 * Auto-detects runtime context (host vs sidecar) from environment variables
 * and provides typed, policy-checked, audit-logged clients for GitHub,
 * Slack, and Linear.
 *
 * EXPLICITLY OUT OF SCOPE:
 * - Anthropic API keys / Claude Code subscription — managed externally
 * - Redis/SSH credential proxying — handled by libaztec-packages
 * - Credential rotation, rate limiting, dry-run mode
 *
 * Usage:
 *   import { createCreds } from "libcreds";
 *   const creds = createCreds({ profile: "default", ... });
 *   const issues = await creds.github.listIssues("AztecProtocol/aztec-packages");
 *   await creds.slack.postMessage("Done!");
 */

// Re-export types
export type {
  SessionContext, ProfileGrant, DangerLevel, ServiceName,
  AuditEntry, TokenSource,
  GitHubOperationName, SlackOperationName, LinearOperationName,
  GitHubGrant, SlackGrant, LinearGrant,
} from "./types.ts";

// Re-export policy
export { LibCredsError } from "./policy.ts";

// Re-export operations (internal use only — prefer typed clients over raw operation lookups)
export { getOperation } from "./operations.ts";

// Re-export grants
export { getProfileGrant, registerProfileGrant } from "./grants.ts";
export {
  DEFAULT_GRANT, BARRETENBERG_AUDIT_GRANT, CLAUDEBOX_DEV_GRANT,
  MINIMAL_GRANT, TEST_GRANT, HOST_GRANT,
} from "./grants.ts";

// Re-export clients
export { GitHubClient } from "./github.ts";
export { SlackClient } from "./slack.ts";
export { LinearClient } from "./linear.ts";

// Re-export singleton
export { getCreds, initCreds } from "./singleton.ts";

// Re-export audit
export { initAuditLog } from "./audit.ts";

import type { SessionContext, ProfileGrant } from "./types.ts";
import { GitHubClient } from "./github.ts";
import { SlackClient } from "./slack.ts";
import { LinearClient } from "./linear.ts";
import { getProfileGrant } from "./grants.ts";
import { initAuditLog } from "./audit.ts";

// ── Creds instance ───────────────────────────────────────────────

export interface Creds {
  /** Typed GitHub API client — policy-checked, audit-logged. */
  github: GitHubClient;
  /** Typed Slack API client — session-scoped, policy-checked. */
  slack: SlackClient;
  /** Typed Linear API client — read-only by default. */
  linear: LinearClient;
  /** The immutable session context. */
  ctx: SessionContext;
  /** The active profile grant. */
  grant: ProfileGrant;
}

export interface CreateCredsOpts {
  /** Profile name (auto-detected from CLAUDEBOX_PROFILE if not provided). */
  profile?: string;
  /** Explicit session context. If not provided, auto-detected from env. */
  ctx?: Partial<SessionContext>;
  /** Explicit grant. If not provided, looked up from profile. */
  grant?: ProfileGrant;
  /** Explicit tokens. If not provided, read from env vars. */
  tokens?: {
    github?: string;
    slack?: string;
    linear?: string;
  };
  /** Audit log path. Defaults to /workspace/activity.jsonl. */
  auditLogPath?: string;
}

/**
 * Create a Creds instance. Auto-detects context from environment.
 *
 * Host mode (has raw tokens): Creates direct API clients.
 * Sidecar mode (has CLAUDEBOX_SERVER_URL): Creates proxied clients.
 */
export function createCreds(opts: CreateCredsOpts = {}): Creds {
  const profile = opts.profile || process.env.CLAUDEBOX_PROFILE || "default";
  const grant = opts.grant || getProfileGrant(profile);

  // Auto-detect runtime
  const isHost = !process.env.CLAUDEBOX_SERVER_URL && !process.env.MCP_PORT;
  const runtime = isHost ? "host" as const : "sidecar" as const;

  // Build session context from env + overrides
  const ctx: SessionContext = {
    sessionId: process.env.SESSION_UUID || process.env.CLAUDEBOX_LOG_ID || "",
    profile,
    user: process.env.CLAUDEBOX_USER || "",
    runtime,
    slackChannel: process.env.CLAUDEBOX_SLACK_CHANNEL || undefined,
    slackThreadTs: process.env.CLAUDEBOX_SLACK_THREAD_TS || undefined,
    slackMessageTs: process.env.CLAUDEBOX_SLACK_MESSAGE_TS || undefined,
    githubRepo: undefined, // Set by profile (e.g., SESSION_META.repo)
    githubCommentId: process.env.CLAUDEBOX_COMMENT_ID || undefined,
    githubRunCommentId: process.env.CLAUDEBOX_RUN_COMMENT_ID || undefined,
    githubRunUrl: process.env.CLAUDEBOX_RUN_URL || undefined,
    githubLink: process.env.CLAUDEBOX_LINK || undefined,
    logId: process.env.CLAUDEBOX_LOG_ID || undefined,
    logUrl: process.env.CLAUDEBOX_LOG_URL || undefined,
    worktreeId: process.env.CLAUDEBOX_WORKTREE_ID || undefined,
    baseBranch: process.env.CLAUDEBOX_BASE_BRANCH || undefined,
    ...opts.ctx,
  };

  // Initialize audit log
  const auditPath = opts.auditLogPath || "/workspace/activity.jsonl";
  initAuditLog({ logPath: auditPath, sessionId: ctx.sessionId, logId: ctx.logId });

  // Resolve tokens
  const ghToken = opts.tokens?.github || process.env.GH_TOKEN || "";
  const slackToken = opts.tokens?.slack || process.env.SLACK_BOT_TOKEN || "";
  const linearToken = opts.tokens?.linear || process.env.LINEAR_API_KEY || "";

  // Sidecar proxy config (if in sidecar mode)
  const serverUrl = process.env.CLAUDEBOX_SERVER_URL;
  const serverToken = process.env.CLAUDEBOX_SERVER_TOKEN;
  const proxy = serverUrl && serverToken
    ? { serverUrl, serverToken, profile }
    : undefined;

  // Create clients
  const github = new GitHubClient({
    token: ghToken,
    ctx,
    grant: grant.github,
  });

  const slack = new SlackClient({
    token: slackToken,
    ctx,
    grant: grant.slack,
    proxy,
  });

  const linear = new LinearClient({
    token: linearToken,
    ctx,
    grant: grant.linear,
  });

  return { github, slack, linear, ctx, grant };
}

/**
 * Create a host-side Creds instance with the _host grant.
 * Used by server.ts and http-routes.ts for trusted server-side operations.
 */
export function createHostCreds(opts?: {
  slackChannel?: string;
  slackThreadTs?: string;
  slackMessageTs?: string;
}): Creds {
  return createCreds({
    profile: "_host",
    ctx: {
      runtime: "host",
      ...opts,
    },
  });
}
