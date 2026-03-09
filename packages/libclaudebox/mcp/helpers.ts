/**
 * Shared helpers for MCP sidecars — git, sanitization, whitelists.
 */

import { execFileSync } from "child_process";
import { IncomingMessage } from "http";
import { createCreds, type Creds } from "../../libcreds/index.ts";

// ── Lazy libcreds instance ──────────────────────────────────────
let _creds: Creds | undefined;
export function getCreds(): Creds {
  if (!_creds) {
    _creds = createCreds();
  }
  return _creds;
}

export function _hasGhToken(): boolean { return getCreds().github.hasToken; }
export function _hasSlackToken(): boolean { return getCreds().slack.hasToken; }
export function _hasLinearToken(): boolean { return getCreds().linear.hasToken; }

// ── Git helper ──────────────────────────────────────────────────
export function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf-8", timeout: 60000 });
}

/** Strip embedded tokens from error messages. */
export function sanitizeError(msg: string): string {
  return msg.replace(/https:\/\/[^@\s]+@/g, "https://***@");
}

// ── GitHub API whitelist builder ────────────────────────────────
export function buildCommonGhWhitelist(R: string): Array<{ method: string; pattern: RegExp }> {
  return [
    { method: "GET",   pattern: new RegExp(`^${R}/pulls(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/pulls/\\d+(/files|/reviews|/comments|/requested_reviewers|/commits)?(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/issues(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/issues/\\d+(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/issues/\\d+/(timeline|events|comments)(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/issues/comments/\\d+$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/actions/workflows(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/actions/runs(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/actions/runs/\\d+(/jobs|/logs)?(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/actions/workflows/[\\w.-]+/runs(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/actions/jobs/\\d+/logs$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/check-runs/\\d+(/annotations)?(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/check-suites/\\d+/check-runs(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/commits/[a-f0-9]+/status(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/commits/[a-f0-9]+/check-runs(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/commits/[a-f0-9]+/check-suites(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/statuses/[a-f0-9]+(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/contents/.*$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/commits(/[^/]+)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/compare/.*$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/branches(/[^/]+)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/git/ref/.*$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/contributors(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/assignees(\\?.*)?$`) },
    { method: "GET",   pattern: new RegExp(`^${R}/collaborators(\\?.*)?$`) },
    { method: "GET",   pattern: /^users\/[^/]+(\/.*)?$/ },
    { method: "GET",   pattern: /^search\/(issues|users|code|repositories)(\?.*)?$/ },
    { method: "GET",   pattern: /^gists(\/[a-f0-9]+)?(\?.*)?$/ },
  ];
}

export function isGhAllowed(method: string, path: string, whitelist: Array<{ method: string; pattern: RegExp }>): boolean {
  const clean = path.replace(/^\//, "");
  return whitelist.some(r => r.method === method.toUpperCase() && r.pattern.test(clean));
}

export const SLACK_WHITELIST = new Set(["chat.postMessage", "chat.update", "reactions.add", "conversations.replies", "users.list"]);

// ── HTTP body reader ────────────────────────────────────────────
const MAX_BODY_BYTES = 10 * 1024 * 1024;
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLen = 0;
    req.on("data", (c: Buffer) => {
      totalLen += c.length;
      if (totalLen > MAX_BODY_BYTES) { req.destroy(); reject(new Error("Request body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ── Slack permalink parser ──────────────────────────────────────
export function parseSlackPermalink(link: string): { channel: string; thread_ts: string } | null {
  const m = link.match(/slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/);
  if (!m) return null;
  const raw = m[2];
  const ts = raw.length > 10 ? raw.slice(0, 10) + "." + raw.slice(10) : raw;
  return { channel: m[1], thread_ts: ts };
}
