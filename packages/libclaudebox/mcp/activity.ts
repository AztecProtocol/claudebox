/**
 * Activity log, comment state, and status building for MCP sidecars.
 */

import { existsSync, readFileSync, appendFileSync } from "fs";
import { SESSION_META, statusPageUrl } from "./env.ts";
import { ServerClient, createServerClientFromEnv } from "../server-client.ts";

// ── Server client (lazy) ────────────────────────────────────────
let _serverClient: ServerClient | null = null;

export function getServerClient(): ServerClient {
  if (!_serverClient) {
    const extraMeta: Record<string, string> = {};
    if (SESSION_META.repo) extraMeta.repo = SESSION_META.repo;
    if (SESSION_META.slack_message_ts) extraMeta.slack_message_ts = SESSION_META.slack_message_ts;
    _serverClient = createServerClientFromEnv(extraMeta);
  }
  return _serverClient;
}

export function setServerClient(client: ServerClient): void {
  _serverClient = client;
}

// ── Activity log ────────────────────────────────────────────────
export const ACTIVITY_LOG = "/workspace/activity.jsonl";

const _seenArtifactUrls = new Set<string>();
let _activityDeduped = false;

function _initActivityDedup(): void {
  if (_activityDeduped) return;
  _activityDeduped = true;
  try {
    if (existsSync(ACTIVITY_LOG)) {
      for (const line of readFileSync(ACTIVITY_LOG, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "artifact") {
            const m = entry.text?.match(/(https?:\/\/[^\s)>\]]+)/);
            if (m) _seenArtifactUrls.add(m[1].replace(/[.,;:!?]+$/, ""));
          }
        } catch {}
      }
    }
  } catch {}
}

export function logActivity(type: string, text: string): void {
  _initActivityDedup();
  if (type === "artifact") {
    const urlMatch = text.match(/(https?:\/\/[^\s)>\]]+)/);
    if (urlMatch) {
      const cleanUrl = urlMatch[1].replace(/[.,;:!?]+$/, "");
      if (_seenArtifactUrls.has(cleanUrl)) return;
      _seenArtifactUrls.add(cleanUrl);
    }
  }
  try {
    const entry: Record<string, string> = { ts: new Date().toISOString(), type, text };
    if (SESSION_META.log_id) entry.log_id = SESSION_META.log_id;
    appendFileSync(ACTIVITY_LOG, JSON.stringify(entry) + "\n");
  } catch {}
}

// ── Root comment state ──────────────────────────────────────────
export let lastStatus = "";
export let respondToUserCalled = false;

export function setRespondToUserCalled(v: boolean): void { respondToUserCalled = v; }
export function setLastStatus(v: string): void { lastStatus = v; }

export const commentSections = {
  status: "" as string,
  statusLog: [] as Array<{ ts: string; text: string }>,
  response: "" as string,
};

export const trackedPRs = new Map<number, { title: string; url: string; action: string }>();
export const otherArtifacts: string[] = [];

export function addProgress(type: "status" | "response", text: string): void {
  if (type === "status") {
    commentSections.status = text;
    commentSections.statusLog.push({ ts: new Date().toISOString(), text });
  } else if (type === "response") {
    commentSections.response = text;
  }
}

export function addTrackedPR(num: number, title: string, url: string, action: "created" | "updated") {
  const existing = trackedPRs.get(num);
  const finalAction = existing?.action === "created" ? "created" : action;
  trackedPRs.set(num, { title, url, action: finalAction });
}

export function truncateForSlack(text: string, maxLen = 600): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function buildArtifactsSlack(): string {
  const prLinks: string[] = [];
  for (const [num, pr] of trackedPRs) {
    prLinks.push(`<${pr.url}|#${num}>`);
  }
  const lines: string[] = [];
  if (prLinks.length) lines.push(prLinks.join(" "));
  if (otherArtifacts.length > 0) lines.push(...otherArtifacts);
  return lines.join("\n");
}

export function buildSlackText(status: string): string {
  const parts: string[] = [];
  if (commentSections.response) {
    parts.push(truncateForSlack(commentSections.response));
  } else if (status) {
    parts.push(truncateForSlack(status));
  }
  const footer: string[] = [];
  const artifacts = buildArtifactsSlack();
  if (artifacts) footer.push(artifacts);
  if (statusPageUrl) footer.push(`<${statusPageUrl}|status>`);
  if (commentSections.response) {
    const tag = status.includes("completed") ? "completed"
      : status.includes("error") ? "error" : "";
    if (tag) footer.push(`_${tag}_`);
  }
  if (footer.length) parts.push(footer.join("  \u2502  "));
  return parts.join("\n");
}

export async function updateRootComment(status?: string): Promise<string[]> {
  const s = status ?? lastStatus;
  if (status) lastStatus = status;

  const client = getServerClient();
  if (!client.hasServer) return [];

  try {
    return await client.updateComment({
      status: s,
      logId: SESSION_META.log_id,
      sections: { ...commentSections },
      trackedPRs: [...trackedPRs.entries()].map(([num, pr]) => ({ num, ...pr })),
      otherArtifacts: [...otherArtifacts],
    });
  } catch (e: any) {
    return [`Server: ${e.message}`];
  }
}
