/**
 * ClaudeBox MCP Base — re-export facade.
 *
 * All profile sidecars import from this file. The implementation is
 * split across env.ts, activity.ts, helpers.ts, tools.ts, git-tools.ts, server.ts.
 */

// ── env ──────────────────────────────────────────────────────────
export {
  PORT, QUIET_MODE, CI_ALLOW, STATS_DIR, CLAUDEBOX_HOST, WORKTREE_ID,
  SESSION_META, sessionScopes, hasScope, statusPageUrl,
} from "./env.ts";

// ── activity ─────────────────────────────────────────────────────
export {
  ACTIVITY_LOG, logActivity,
  lastStatus, respondToUserCalled, setRespondToUserCalled, setLastStatus,
  commentSections, trackedPRs, otherArtifacts,
  addProgress, addTrackedPR, truncateForSlack, buildSlackText, updateRootComment,
  getServerClient, setServerClient,
} from "./activity.ts";

// ── helpers ──────────────────────────────────────────────────────
export {
  getCreds,
  git, sanitizeError,
  buildCommonGhWhitelist, isGhAllowed, SLACK_WHITELIST,
  readBody, parseSlackPermalink,
} from "./helpers.ts";

// ── tools ────────────────────────────────────────────────────────
export { registerCommonTools, workspaceName } from "./tools.ts";
export type { ProfileOpts } from "./tools.ts";

// ── git tools ────────────────────────────────────────────────────
export {
  cloneRepoCheckoutAndInit, pushToRemote,
  registerCloneRepo, registerPRTools,
} from "./git-tools.ts";
export type { CloneToolConfig, PRToolConfig } from "./git-tools.ts";

// ── server ───────────────────────────────────────────────────────
export { startMcpHttpServer } from "./server.ts";

// ── re-exports for profile convenience ──────────────────────────
export { z } from "zod";
export { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export { ServerClient, createServerClientFromEnv } from "../server-client.ts";
