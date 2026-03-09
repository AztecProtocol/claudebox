import type { ParseResult, RunMeta } from "./types.ts";
import { CLAUDEBOX_HOST, LOG_BASE_URL } from "./config.ts";
import { discoverProfiles } from "./profile-loader.ts";

export function truncate(s: string, n = 80): string {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}

export function extractHashFromUrl(text: string): string | null {
  // Match log URLs: <LOG_BASE_URL>/<worktreeId>-<seq> or legacy <LOG_BASE_URL>/<32hex>
  const escaped = LOG_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/^https?/, "https?");
  const m = text.match(new RegExp(`^<?${escaped}/([a-f0-9][\\w-]+)>?`));
  return m ? m[1] : null;
}

/** Parse incoming text into either a hash-based reply or a plain prompt. */
export function parseMessage(text: string, findSession: (hash: string) => RunMeta | null): ParseResult {
  const parts = text.split(/\s+/);
  const first = parts[0] || "";
  const rest = text.slice(first.length).trim();

  const urlHash = extractHashFromUrl(first);
  if (urlHash) return { type: "reply-hash", hash: urlHash, prompt: rest };

  // Match new format: <worktreeId>-<seq> (e.g. d9441073aae158ae-1)
  if (/^[a-f0-9]{16}-\d+$/.test(first) && findSession(first)) {
    return { type: "reply-hash", hash: first, prompt: rest };
  }

  // Legacy: 32-hex session hash
  if (/^[a-f0-9]{32}$/.test(first) && findSession(first)) {
    return { type: "reply-hash", hash: first, prompt: rest };
  }

  return { type: "prompt", prompt: text };
}

export interface ParsedKeywords {
  forceNew: boolean;
  quiet: boolean | null;  // null = use auto-detect
  ciAllow: boolean;
  profile: string;  // "" = default
  prompt: string;
}

// Profile keywords are derived from discovered profiles (excludes "default")
const PROFILE_KEYWORDS = discoverProfiles().filter(p => p !== "default");

/** Detect keywords (new-session, quiet, loud, ci-allow, profile names) at start of prompt, in any order. */
export function parseKeywords(parsed: ParseResult): ParsedKeywords {
  let prompt = parsed.prompt;
  let forceNew = false;
  let quiet: boolean | null = null;
  let ciAllow = false;
  let profile = "";

  let changed = true;
  while (changed) {
    changed = false;
    if (/^new-session\b/i.test(prompt)) {
      forceNew = true; prompt = prompt.replace(/^new-session\s*/i, ""); changed = true;
    }
    if (/^quiet\b/i.test(prompt)) {
      quiet = true; prompt = prompt.replace(/^quiet\s*/i, ""); changed = true;
    }
    if (/^loud\b/i.test(prompt)) {
      quiet = false; prompt = prompt.replace(/^loud\s*/i, ""); changed = true;
    }
    if (/^(ci-allow|allow-ci)\b/i.test(prompt)) {
      ciAllow = true; prompt = prompt.replace(/^(ci-allow|allow-ci)\s*/i, ""); changed = true;
    }
    for (const kw of PROFILE_KEYWORDS) {
      const re = new RegExp(`^${kw}\\b`, "i");
      if (re.test(prompt)) {
        profile = kw; prompt = prompt.replace(new RegExp(`^${kw}\\s*`, "i"), ""); changed = true; break;
      }
    }
  }
  return { forceNew, quiet, ciAllow, profile, prompt };
}

/** Validate a session for resume. Returns error message or null if OK. */
export function validateResumeSession(session: RunMeta | null, hash: string): string | null {
  if (!session) return `Session \`${hash}\` not found.`;
  if (session.status === "running") return "Session is still running. Your message will be queued.";
  if (!session.worktree_id) return `Session \`${hash}\` has no worktree.`;
  return null;
}

/** Build status page URL from worktree ID. */
export function sessionUrl(worktreeId: string): string {
  return `https://${CLAUDEBOX_HOST}/s/${worktreeId}`;
}

/** Extract a PR binding key ("owner/repo#123") from a GitHub PR URL. Returns null if not a PR link. */
export function prKeyFromUrl(url: string): string | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : null;
}
