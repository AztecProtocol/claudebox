import type { ParseResult, RunMeta } from "./types.ts";
import { CLAUDEBOX_HOST, LOG_BASE_URL } from "./config.ts";
import { discoverProfiles } from "./profile-loader.ts";

export function truncate(s: string, n = 80): string {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}

export function extractHashFromUrl(text: string): string | null {
  // Match session page URLs: <host>/s/<worktreeId>
  const hostEscaped = CLAUDEBOX_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pageM = text.match(new RegExp(`^<?https?://${hostEscaped}/s/([a-f0-9]{16})>?`));
  if (pageM) return pageM[1];
  // Match legacy log URLs: <LOG_BASE_URL>/<logId>
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
  ciAllow: boolean;
  cronAllow: boolean;
  listCrons: string | true | false;  // false=unset, true=current channel, string=specific channelId
  profile: string;  // "" = default
  prompt: string;
}

// Profile keywords are derived from discovered profiles (excludes "default")
const PROFILE_KEYWORDS = discoverProfiles().filter(p => p !== "default");

// Boolean --flags: flag string → key in ParsedKeywords
const BOOLEAN_FLAGS: Array<[string, "forceNew" | "ciAllow" | "cronAllow"]> = [
  ["--new-session", "forceNew"],
  ["--ci-allow", "ciAllow"],
  ["--cron-allow", "cronAllow"],
];

/** Parse --flags and profile keywords from the start of a prompt. */
export function parseKeywords(parsed: ParseResult): ParsedKeywords {
  let prompt = parsed.prompt;
  const boolFlags: Record<string, boolean> = { forceNew: false, ciAllow: false, cronAllow: false };
  let listCrons: string | true | false = false;
  let profile = "";

  let changed = true;
  while (changed) {
    changed = false;

    // --flag parsing
    for (const [flag, key] of BOOLEAN_FLAGS) {
      if (prompt.toLowerCase().startsWith(flag) && (prompt.length === flag.length || /\s/.test(prompt[flag.length]))) {
        boolFlags[key] = true;
        prompt = prompt.slice(flag.length).trimStart();
        changed = true;
        break;
      }
    }

    // --list-crons [channelId]
    if (/^--list-crons(?:\s|$)/i.test(prompt)) {
      prompt = prompt.slice("--list-crons".length).trimStart();
      // Optional channel ID argument
      const channelMatch = prompt.match(/^([A-Z][A-Z0-9]+)\s*/);
      if (channelMatch) {
        listCrons = channelMatch[1];
        prompt = prompt.slice(channelMatch[0].length);
      } else {
        listCrons = true;
      }
      changed = true;
      continue;
    }

    // Profile keywords (bare words, no -- prefix)
    for (const kw of PROFILE_KEYWORDS) {
      const re = new RegExp(`^${kw}\\b`, "i");
      if (re.test(prompt)) {
        profile = kw; prompt = prompt.replace(new RegExp(`^${kw}\\s*`, "i"), ""); changed = true; break;
      }
    }
  }
  return {
    forceNew: boolFlags.forceNew,
    ciAllow: boolFlags.ciAllow,
    cronAllow: boolFlags.cronAllow,
    listCrons,
    profile,
    prompt: prompt.trim(),
  };
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

/** Extract worktree ID from a log URL. Handles session page URLs, legacy logId URLs, and raw logId strings. */
export function worktreeIdFromLogUrl(logUrl: string): string {
  // Session page format: /s/<worktreeId>
  const m0 = logUrl.match(/\/s\/([a-f0-9]{16})(?:\?|$|#)/);
  if (m0) return m0[1];
  // LogId format: <worktreeId>-<seq>
  const m1 = logUrl.match(/\/([a-f0-9]{16})-\d+$/);
  if (m1) return m1[1];
  // Legacy: <32hex> — no worktree ID embedded
  return "";
}

/** Extract the full log ID from a log URL. */
export function hashFromLogUrl(logUrl: string): string {
  // Session page format: /s/<worktreeId>
  const m0 = logUrl.match(/\/s\/([a-f0-9]{16})(?:\?|$|#)/);
  if (m0) return m0[1];
  const m = logUrl.match(/\/([a-f0-9][\w-]+)$/);
  return m ? m[1] : "";
}

/** Extract a PR binding key ("owner/repo#123") from a GitHub PR URL. Returns null if not a PR link. */
export function prKeyFromUrl(url: string): string | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : null;
}
