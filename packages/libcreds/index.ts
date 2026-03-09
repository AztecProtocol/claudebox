/**
 * libcreds — Centralized credential management for ClaudeBox.
 *
 * Security core: typed, grant-checked, audit-logged clients for
 * GitHub, Slack, and Linear. No escape hatches.
 *
 * Usage:
 *   const creds = createCreds({ profile: "default" });
 *   const issues = await creds.github.listIssues("AztecProtocol/aztec-packages");
 *   await creds.slack.postMessage("Done!");
 */

export type {
  SessionContext, ProfileGrant, AccessLevel, ServiceName, AuditEntry,
  GitHubGrant, SlackGrant, LinearGrant,
} from "./types.ts";

export { getProfileGrant, registerProfileGrant } from "./grants.ts";
export {
  DEFAULT_GRANT, BARRETENBERG_AUDIT_GRANT, CLAUDEBOX_DEV_GRANT,
  MINIMAL_GRANT, TEST_GRANT, HOST_GRANT,
} from "./grants.ts";

export { GitHubClient } from "./github.ts";
export { SlackClient } from "./slack.ts";
export { LinearClient } from "./linear.ts";

import type { SessionContext, ProfileGrant } from "./types.ts";
import { GitHubClient } from "./github.ts";
import { SlackClient } from "./slack.ts";
import { LinearClient } from "./linear.ts";
import { getProfileGrant } from "./grants.ts";
import { initAuditLog } from "./audit.ts";

// ── Creds instance ───────────────────────────────────────────────

export interface Creds {
  github: GitHubClient;
  slack: SlackClient;
  linear: LinearClient;
  ctx: SessionContext;
  grant: ProfileGrant;
}

export interface CreateCredsOpts {
  profile?: string;
  ctx?: Partial<SessionContext>;
  grant?: ProfileGrant;
  tokens?: { github?: string; slack?: string; linear?: string };
  auditLogPath?: string;
}

/**
 * Create a Creds instance. Auto-detects context from environment.
 *
 * Host mode (has raw tokens): Creates direct API clients.
 * Sidecar mode (has CLAUDEBOX_SERVER_URL): Creates proxied Slack client.
 */
export function createCreds(opts: CreateCredsOpts = {}): Creds {
  const profile = opts.profile || process.env.CLAUDEBOX_PROFILE || "default";
  const grant = opts.grant || getProfileGrant(profile);
  const isHost = !process.env.CLAUDEBOX_SERVER_URL && !process.env.MCP_PORT;
  const runtime = isHost ? "host" as const : "sidecar" as const;

  const ctx: SessionContext = {
    sessionId: process.env.SESSION_UUID || process.env.CLAUDEBOX_LOG_ID || "",
    profile,
    user: process.env.CLAUDEBOX_USER || "",
    runtime,
    slackChannel: process.env.CLAUDEBOX_SLACK_CHANNEL || undefined,
    slackThreadTs: process.env.CLAUDEBOX_SLACK_THREAD_TS || undefined,
    slackMessageTs: process.env.CLAUDEBOX_SLACK_MESSAGE_TS || undefined,
    githubRepo: undefined,
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

  const auditPath = opts.auditLogPath || "/workspace/activity.jsonl";
  initAuditLog({ logPath: auditPath, sessionId: ctx.sessionId, logId: ctx.logId, profile });

  const ghToken = opts.tokens?.github || process.env.GH_TOKEN || "";
  const slackToken = opts.tokens?.slack || process.env.SLACK_BOT_TOKEN || "";
  const linearToken = opts.tokens?.linear || process.env.LINEAR_API_KEY || "";

  const serverUrl = process.env.CLAUDEBOX_SERVER_URL;
  const serverToken = process.env.CLAUDEBOX_SERVER_TOKEN;
  const proxy = serverUrl && serverToken ? { serverUrl, serverToken, profile } : undefined;

  return {
    github: new GitHubClient({ token: ghToken, ctx, grant: grant.github }),
    slack: new SlackClient({ token: slackToken, ctx, grant: grant.slack, proxy }),
    linear: new LinearClient({ token: linearToken, ctx, grant: grant.linear }),
    ctx, grant,
  };
}

/** Create a host-side Creds with the _host grant. For server.ts/http-routes.ts only. */
export function createHostCreds(opts?: {
  slackChannel?: string;
  slackThreadTs?: string;
  slackMessageTs?: string;
}): Creds {
  return createCreds({ profile: "_host", ctx: { runtime: "host", ...opts } });
}
