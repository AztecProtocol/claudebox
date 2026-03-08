export type { SessionMeta } from "../types.ts";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Sanitize a URL for use in href — only allow http/https schemes. */
export function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? esc(url) : "#";
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

export function statusColor(s: string): string {
  if (s === "running") return "#61D668";
  if (s === "completed") return "#61D668";
  if (s === "error") return "#E94560";
  if (s === "cancelled") return "#888";
  if (s === "interrupted") return "#FAD979";
  return "#888";
}

// ── Shared styles ──────────────────────────────────────────────

export const BASE_STYLES = `
body{background:#000;color:#ccc;font-family:monospace;padding:10px;font-size:14px;line-height:1.5}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
.output{white-space:pre-wrap;word-wrap:break-word}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#000}
::-webkit-scrollbar-thumb{background:#444;border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:#555}
`;

// ── Auth styles ─────────────────────────────────────────────────

export const AUTH_STYLES = `
.login-overlay{position:fixed;inset:0;background:#0a0a0a;display:flex;align-items:center;justify-content:center;z-index:100}
.login-form{background:#111;border:1px solid #333;border-radius:12px;padding:24px;width:280px;display:flex;flex-direction:column;gap:12px}
.login-title{color:#5FA7F1;font-weight:600;font-size:16px;text-align:center}
.form-input{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 12px;color:#d4d4d4;font-family:inherit;font-size:13px}
.form-input:focus{border-color:#5FA7F1;outline:none}
.form-error{color:#E94560;font-size:11px;text-align:center}
.btn{border:none;border-radius:8px;padding:8px 16px;font-family:inherit;font-size:13px;cursor:pointer;transition:opacity 0.15s}
.btn:hover{opacity:0.85}
.btn:disabled{opacity:0.5;cursor:default}
.btn-blue{background:#5FA7F1;color:#000}
.btn-red{background:#E94560;color:#fff}
.btn-send{background:#61D668;color:#000}
`;

// ── Workspace Page ─────────────────────────────────────────────

export interface ActivityEntry {
  ts: string;
  type: string;  // "status", "response", "artifact", "tool_use", "agent_start", "context", "clone"
  text: string;
}

export interface WorkspacePageData {
  hash: string;            // current session log_id
  session: SessionMeta;    // current session
  sessions: SessionMeta[]; // all sessions for this worktree (newest first)
  worktreeAlive: boolean;
  activity: ActivityEntry[];  // newest first
}

export function linkify(text: string): string {
  // First convert markdown links [text](url) to HTML (escape label for XSS safety)
  const withMdLinks = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    return `<a href="${esc(url)}" target="_blank" class="link">${esc(label)}</a>`;
  });
  // Then convert remaining bare URLs (skip those already inside <a> tags)
  const parts = withMdLinks.split(/(<a [^>]*>.*?<\/a>)/g);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith("<a ")) continue; // already a link
    // Escape non-link text
    parts[i] = esc(parts[i]);
    parts[i] = parts[i].replace(/(https?:\/\/[^\s&<"']+)/g, (m) => {
      let url = m.replace(/[.,;:!?)}&amp;\]]+$/, '');
      const stripped = m.slice(url.length);
      for (const ch of stripped) {
        if (ch === ')' && (url.split('(').length > url.split(')').length)) {
          url += ch;
        } else break;
      }
      return `<a href="${url}" target="_blank" class="link">${url}</a>${m.slice(url.length)}`;
    });
  }
  return parts.join("");
}

/**
 * Compact artifact text into short clickable links.
 * "- [PR #5: title](url)" → "PR #5" linked
 * "Issue #70: title — url" → "#70" linked
 * "Closed issue #70: title — url" → "Closed #70" linked
 * "Cross-ref #70: context" → "Cross-ref #70" linked
 * "Gist: url" → "Gist" linked
 * "Skill PR [/name #3](url)" → "PR #3 /name" linked
 * "Created audit label: scope/slug" → "Label scope/slug"
 */
function compactArtifact(text: string): string {
  // PR: "- [PR #5: title](url)" or markdown link with PR
  const prMd = text.match(/\[(?:PR )?#(\d+)[^\]]*\]\((https?:\/\/[^)]+)\)/);
  if (prMd) return `<a href="${esc(prMd[2])}" target="_blank" class="link artifact-link">PR #${prMd[1]}</a>`;

  // Issue: "Issue #70: title — url"
  const issueMatch = text.match(/^(?:Closed )?[Ii]ssue #(\d+).*?(https?:\/\/\S+)/);
  if (issueMatch) {
    const prefix = text.startsWith("Closed") ? "Closed " : "";
    return `<a href="${esc(issueMatch[2])}" target="_blank" class="link artifact-link">${prefix}#${issueMatch[1]}</a>`;
  }

  // Cross-ref: "Cross-ref #70: context"
  const xrefMatch = text.match(/^Cross-ref #(\d+)/);
  if (xrefMatch) {
    // Try to extract URL if present
    const urlMatch = text.match(/(https?:\/\/\S+)/);
    if (urlMatch) return `<a href="${esc(urlMatch[1])}" target="_blank" class="link artifact-link">Cross-ref #${xrefMatch[1]}</a>`;
    return `<span class="artifact-link">Cross-ref #${xrefMatch[1]}</span>`;
  }

  // Gist: "Gist: url"
  const gistMatch = text.match(/^Gist:\s*(https?:\/\/\S+)/);
  if (gistMatch) return `<a href="${esc(gistMatch[1])}" target="_blank" class="link artifact-link">Gist</a>`;

  // Skill: "Skill PR [/name #3](url)" or similar
  const skillMatch = text.match(/[Ss]kill.*?#(\d+).*?(https?:\/\/\S+)/);
  if (skillMatch) return `<a href="${esc(skillMatch[2])}" target="_blank" class="link artifact-link">PR #${skillMatch[1]}</a>`;

  // Audit label: "Created audit label: scope/slug"
  const labelMatch = text.match(/audit label:\s*(\S+)/);
  if (labelMatch) return `<span class="artifact-link">Label ${esc(labelMatch[1])}</span>`;

  // Fallback: linkify the whole text
  return linkify(text);
}

export function renderUserMsg(promptText: string, t: string, user: string): string {
  return `<div class="chat-msg user"><div class="chat-bubble user-bubble"><div class="chat-text">${promptText}</div><div class="chat-time">${t}</div></div><div class="chat-avatar user-avatar">${esc(user.slice(0, 2).toUpperCase())}</div></div>`;
}

export function renderActivityEntry(a: ActivityEntry, agentLogUrl?: string): string {
  const linked = linkify(a.text);
  const timeStr = a.ts ? timeAgo(a.ts) : "";
  const msgHash = Buffer.from(a.text.slice(0, 50)).toString("base64url").slice(0, 12);
  if (a.type === "response") {
    return `<div class="chat-msg bot" data-msg="${msgHash}"><div class="chat-avatar reply-avatar">RE</div><div class="chat-bubble reply-bubble"><div class="chat-label reply-label">reply</div><div class="chat-text">${linked}</div><div class="chat-time">${timeStr}</div></div></div>`;
  } else if (a.type === "context") {
    return `<div class="chat-msg bot" data-msg="${msgHash}"><div class="chat-avatar">CB</div><div class="chat-bubble context-bubble"><div class="chat-text">${linked}</div><div class="chat-time">${timeStr}</div></div></div>`;
  } else if (a.type === "artifact") {
    // Compact artifact rendering — show short #N links instead of full text
    const compact = compactArtifact(a.text);
    return `<div class="chat-status artifact-line" data-msg="${msgHash}"><span class="artifact-icon">\u25C6</span><span>${compact}</span><span class="ts">${timeStr}</span></div>`;
  } else if (a.type === "agent_start") {
    const agentText = agentLogUrl
      ? `<a href="${agentLogUrl}" target="_blank" class="link">Agent: ${linked}</a>`
      : `Agent: ${linked}`;
    return `<div class="chat-agent" data-msg="${msgHash}"><div class="agent-dot"></div><span>${agentText}</span><span class="dim" style="margin-left:auto;font-size:10px">${timeStr}</span></div>`;
  } else if (a.type === "tool_use") {
    const raw = a.text || "";
    const bashMatch = raw.match(/^(?:(.+?):\s*)?\$\s+(.+)$/);
    if (bashMatch) {
      const desc = bashMatch[1] ? `<span class="tool-desc">${esc(bashMatch[1])} </span>` : "";
      return `<div class="chat-status" data-msg="${msgHash}"><span class="tool-icon">\u25B8</span><code>${desc}<span class="tool-bash">$</span> <span class="tool-args">${esc(bashMatch[2])}</span></code><span class="ts">${timeStr}</span></div>`;
    }
    const spIdx = raw.indexOf(" ");
    const toolName = spIdx > 0 ? esc(raw.slice(0, spIdx)) : esc(raw);
    const toolArgs = spIdx > 0 ? linkify(raw.slice(spIdx)) : "";
    return `<div class="chat-status" data-msg="${msgHash}"><span class="tool-icon">\u25B8</span><code><span class="tool-name">${toolName}</span><span class="tool-args">${toolArgs}</span></code><span class="ts">${timeStr}</span></div>`;
  } else if (a.type === "tool_result") {
    return `<div class="chat-status" data-msg="${msgHash}"><span class="tool-icon">\u25C2</span><code><span class="tool-args">${linked}</span></code><span class="ts">${timeStr}</span></div>`;
  } else if (a.type === "status") {
    return `<div class="chat-status" data-msg="${msgHash}"><span class="tool-icon">\u25CB</span><span>${linked}</span><span class="ts">${timeStr}</span></div>`;
  }
  return `<div class="chat-status" data-msg="${msgHash}"><span class="tool-icon">\u00B7</span><span>${linked}</span><span class="ts">${timeStr}</span></div>`;
}


export interface WorkspaceCard {
  worktreeId: string;
  name: string | null;
  resolved: boolean;
  alive: boolean;
  status: string;
  exitCode: number | null;
  user: string;
  prompt: string;
  started: string | null;
  baseBranch: string;
  channelName: string;
  runCount: number;
  profile?: string;
}
