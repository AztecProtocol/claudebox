/**
 * MCP sidecar environment config — reads env vars, builds session metadata.
 */

import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export const PORT = parseInt(process.env.MCP_PORT || "9801", 10);
export const QUIET_MODE = process.env.CLAUDEBOX_QUIET === "1";
export const CI_ALLOW = process.env.CLAUDEBOX_CI_ALLOW === "1";
export const STATS_DIR = process.env.CLAUDEBOX_STATS_DIR || "/stats";
export const CLAUDEBOX_HOST = process.env.CLAUDEBOX_HOST || "claudebox.work";
export const WORKTREE_ID = process.env.CLAUDEBOX_WORKTREE_ID || "";

export const SESSION_META = {
  log_id: process.env.CLAUDEBOX_LOG_ID || "",
  log_url: process.env.CLAUDEBOX_LOG_URL || "",
  user: process.env.CLAUDEBOX_USER || "",
  repo: "",  // Set by profile
  comment_id: process.env.CLAUDEBOX_COMMENT_ID || "",
  run_comment_id: process.env.CLAUDEBOX_RUN_COMMENT_ID || "",
  run_url: process.env.CLAUDEBOX_RUN_URL || "",
  link: process.env.CLAUDEBOX_LINK || "",
  slack_channel: process.env.CLAUDEBOX_SLACK_CHANNEL || "",
  slack_thread_ts: process.env.CLAUDEBOX_SLACK_THREAD_TS || "",
  slack_message_ts: process.env.CLAUDEBOX_SLACK_MESSAGE_TS || "",
  base_branch: process.env.CLAUDEBOX_BASE_BRANCH || "next",
};

// ── Session scopes ───────────────────────────────────────────────
const _scopes = new Set(
  (process.env.CLAUDEBOX_SCOPES || "").split(",").filter(Boolean),
);
export const sessionScopes = _scopes;
export function hasScope(name: string): boolean {
  return _scopes.has(name);
}

export const statusPageUrl = WORKTREE_ID ? `https://${CLAUDEBOX_HOST}/s/${WORKTREE_ID}` : "";

// ── Per-session metadata directory ───────────────────────────────
if (WORKTREE_ID) {
  const sessionDir = join(process.env.HOME || "/home/claude", ".claudebox", "sessions", WORKTREE_ID);
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "meta.json"), JSON.stringify({
      log_id: SESSION_META.log_id,
      worktree_id: WORKTREE_ID,
      user: SESSION_META.user,
      repo: SESSION_META.repo,
      profile: process.env.CLAUDEBOX_PROFILE || "",
      scopes: [..._scopes],
      started: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.warn(`[MCP] Failed to create session dir: ${e}`);
  }
}
