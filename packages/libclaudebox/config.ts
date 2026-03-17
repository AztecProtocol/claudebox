import { join, dirname } from "path";
import { homedir } from "os";

// ── Environment ─────────────────────────────────────────────────
// Token env vars (SLACK_BOT_TOKEN, GH_TOKEN, LINEAR_API_KEY) are now
// centralized in libcreds / libcreds-host. Do NOT read them here.
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN!;
export const API_SECRET = process.env.CLAUDEBOX_API_SECRET || "";
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
export const HTTP_PORT = parseInt(process.env.CLAUDEBOX_PORT || "3000", 10);
export const INTERNAL_PORT = parseInt(process.env.CLAUDEBOX_INTERNAL_PORT || String(HTTP_PORT + 2), 10);
export const MAX_CONCURRENT = 10;

// ── Paths ───────────────────────────────────────────────────────
export const REPO_DIR = process.env.CLAUDE_REPO_DIR ?? join(homedir(), "repo");
export const DOCKER_IMAGE = process.env.CLAUDEBOX_DOCKER_IMAGE || "devbox:latest";
export const CLAUDEBOX_DIR = join(homedir(), ".claudebox");
export const SESSIONS_DIR = join(CLAUDEBOX_DIR, "sessions");
export const CLAUDEBOX_SESSIONS_DIR = SESSIONS_DIR; // alias for back-compat
export const CLAUDEBOX_WORKTREES_DIR = join(CLAUDEBOX_DIR, "worktrees");
export const CLAUDEBOX_STATS_DIR = join(CLAUDEBOX_DIR, "stats");
// Parent of packages/libclaudebox/ — the root claudebox directory
export const CLAUDEBOX_CODE_DIR = join(dirname(import.meta.url.replace("file://", "")), "../..");
export const CLAUDE_BINARY = process.env.CLAUDE_BINARY ?? join(homedir(), ".local", "bin", "claude");
export const BASTION_SSH_KEY = join(homedir(), ".ssh", "build_instance_key");

// ── Interactive session config ──────────────────────────────────
export const CLAUDEBOX_HOST = process.env.CLAUDEBOX_HOST || "localhost:3000";
export const SESSION_PAGE_USER = process.env.CLAUDEBOX_SESSION_USER || "aztec";
export const SESSION_PAGE_PASS = process.env.CLAUDEBOX_SESSION_PASS || "";

// ── Log URL builder ─────────────────────────────────────────────
// Points to the session page on CLAUDEBOX_HOST (e.g. claudebox.work/s/<worktreeId>).
// The logId format is <worktreeId>-<seq>, so we extract the worktreeId prefix.
export const LOG_BASE_URL = `https://${CLAUDEBOX_HOST}`;
export function buildLogUrl(logId: string): string {
  // Extract worktreeId and seq from logId (e.g. "d9441073aae158ae-3" → worktree "d9441073aae158ae", run "3")
  const worktreeId = logId.replace(/-\d+$/, "");
  const seq = logId.match(/-(\d+)$/)?.[1] || "";
  return `${LOG_BASE_URL}/s/${worktreeId}${seq ? `?run=${seq}` : ""}`;
}

export const DEFAULT_BASE_BRANCH = process.env.CLAUDEBOX_DEFAULT_BRANCH || "main";
