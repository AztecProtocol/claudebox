import { join, dirname } from "path";
import { homedir } from "os";

// ── Environment ─────────────────────────────────────────────────
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN!;
export const GH_TOKEN = process.env.GH_TOKEN || "";
export const API_SECRET = process.env.CLAUDEBOX_API_SECRET || "";
export const HTTP_PORT = parseInt(process.env.CLAUDEBOX_PORT || "3000", 10);
export const MAX_CONCURRENT = 10;

// ── Paths ───────────────────────────────────────────────────────
export const REPO_DIR = process.env.CLAUDE_REPO_DIR ?? join(homedir(), "repo");
export const SESSIONS_DIR = join(REPO_DIR, ".claude", "claudebox", "sessions");
export const DOCKER_IMAGE = process.env.CLAUDEBOX_DOCKER_IMAGE || "claudebox:latest";
export const CLAUDEBOX_DIR = join(homedir(), ".claudebox");
export const CLAUDEBOX_SESSIONS_DIR = join(CLAUDEBOX_DIR, "sessions"); // legacy
export const CLAUDEBOX_WORKTREES_DIR = join(CLAUDEBOX_DIR, "worktrees");
export const CLAUDEBOX_STATS_DIR = join(CLAUDEBOX_DIR, "stats");
// Parent of packages/libclaudebox/ — the root claudebox directory
export const CLAUDEBOX_CODE_DIR = join(dirname(import.meta.url.replace("file://", "")), "../..");
export const CLAUDE_BINARY = process.env.CLAUDE_BINARY ?? join(homedir(), ".local", "bin", "claude");
export const BASTION_SSH_KEY = join(homedir(), ".ssh", "build_instance_key");

// ── Anthropic API proxy ──────────────────────────────────────
export const ANTHROPIC_PROXY_PORT = parseInt(process.env.ANTHROPIC_PROXY_PORT || "8378", 10);

// ── Interactive session config ──────────────────────────────────
export const CLAUDEBOX_HOST = process.env.CLAUDEBOX_HOST || "localhost:3000";
export const SESSION_PAGE_USER = process.env.CLAUDEBOX_SESSION_USER || "admin";
export const SESSION_PAGE_PASS = (() => {
  const v = process.env.CLAUDEBOX_SESSION_PASS;
  if (!v) {
    console.error("[FATAL] CLAUDEBOX_SESSION_PASS must be set");
    process.exit(1);
  }
  return v;
})();

// ── Log URL builder ─────────────────────────────────────────────
// Override with CLAUDEBOX_LOG_BASE_URL to change from default.
export const LOG_BASE_URL = process.env.CLAUDEBOX_LOG_BASE_URL || `http://${CLAUDEBOX_HOST}`;
export function buildLogUrl(logId: string): string {
  return `${LOG_BASE_URL}/${logId}`;
}

// ── Channel → branch and channel → profile maps ────────────────
// Populated by profile loader at startup via setChannelMaps().
let _channelBranches: Record<string, string> = {};
let _channelProfiles: Record<string, string> = {};

export function setChannelMaps(branches: Record<string, string>, profiles: Record<string, string>): void {
  _channelBranches = branches;
  _channelProfiles = profiles;
}
export function getChannelBranches(): Record<string, string> { return _channelBranches; }
export function getChannelProfiles(): Record<string, string> { return _channelProfiles; }

export const DEFAULT_BASE_BRANCH = process.env.CLAUDEBOX_DEFAULT_BRANCH || "main";

// ── Mutable session counter ─────────────────────────────────────
let _activeSessions = 0;
export function getActiveSessions(): number { return _activeSessions; }
export function incrActiveSessions(): void { _activeSessions++; }
export function decrActiveSessions(): void { _activeSessions--; }
