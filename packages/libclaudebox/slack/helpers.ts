import type { RunMeta } from "../types.ts";
import type { WorktreeStore } from "../worktree-store.ts";
import type { DockerService } from "../docker.ts";
import { truncate, extractHashFromUrl, sessionUrl } from "../util.ts";
import { toTargetRef } from "../base-branch.ts";
import { getSummaryPrompt } from "../profile-loader.ts";
import { getHostCreds } from "../../libcreds-host/index.ts";

/**
 * Convert Markdown-style links and bare URLs to Slack mrkdwn format.
 * Handles: `[text](url)` → `<url|text>`, bare `https://...` → `<url>`
 */
export function markdownToSlack(text: string): string {
  // Convert Markdown links [text](url) → <url|text>
  let result = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // Wrap remaining bare URLs that aren't already inside <...>
  result = result.replace(/(?<![<|])(https?:\/\/[^\s>]+)/g, (_, url) => {
    const clean = url.replace(/[.,;:!?)+\]]+$/, '');
    return `<${clean}>${url.slice(clean.length)}`;
  });
  return result;
}

export function resolveUserName(client: any, userId: string): Promise<string> {
  return client.users
    .info({ user: userId })
    .then((r: any) => r.user?.real_name ?? userId)
    .catch(() => userId);
}

export async function getThreadContext(client: any, channel: string, threadTs: string): Promise<string> {
  if (!threadTs) return "";
  try {
    const result = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    const msgs = result.messages ?? [];
    const cache: Record<string, string> = {};
    const lines: string[] = [];
    for (const msg of msgs) {
      const uid = msg.user ?? "unknown";
      if (!cache[uid]) cache[uid] = await resolveUserName(client, uid);
      const text = (msg.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
      if (text) lines.push(`${cache[uid]}: ${text}`);
    }
    return lines.join("\n");
  } catch (e) {
    const detail = (e as any)?.data?.needed ? ` (need scope: ${(e as any).data.needed})` : "";
    console.warn(`[WARN] Could not fetch thread context for ${channel}: ${e}${detail}`);
    return "";
  }
}

/** Extract compact artifact links from activity entries. */
function extractArtifactLinks(artifacts: { text: string }[]): string[] {
  const seenUrls = new Set<string>();
  const linkParts: string[] = [];
  for (const a of artifacts) {
    const urlMatch = a.text.match(/(https?:\/\/[^\s)>\]]+)/);
    if (!urlMatch) continue;
    const url = urlMatch[1].replace(/[.,;:!?]+$/, '');
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const prMatch = url.match(/\/pull\/(\d+)/);
    if (prMatch) { linkParts.push(`<${url}|#${prMatch[1]}>`); continue; }
    if (url.includes("gist.github")) { linkParts.push(`<${url}|gist>`); continue; }
    const issueMatch = url.match(/\/issues\/(\d+)/);
    if (issueMatch) { linkParts.push(`<${url}|#${issueMatch[1]}>`); continue; }
    linkParts.push(`<${url}|link>`);
  }
  return linkParts;
}

/** Build final Slack message from activity log — the single source of truth.
 *  Only shows artifacts from the current resume (scoped by logId). */
export function buildSlackStatusFromActivity(
  activity: { ts: string; type: string; text: string; log_id?: string }[],
  prompt: string,
  status: string,
  logUrl: string,
  worktreeId?: string,
  logId?: string,
): string {
  const parts: string[] = [];

  // Only show the LAST response (not every intermediate respond_to_user call)
  const responses = activity.filter(a => a.type === "response");
  if (responses.length > 0) {
    const last = responses[responses.length - 1];
    let text = last.text.length > 600 ? last.text.slice(0, 600) + "\u2026" : last.text;
    parts.push(markdownToSlack(text));
  }

  // Artifacts scoped to current resume (by log_id), deduplicated
  const currentLogId = logId || (activity.length > 0 ? activity[activity.length - 1].log_id : undefined);
  const artifacts = activity.filter(a => a.type === "artifact" && (!currentLogId || !a.log_id || a.log_id === currentLogId));
  const linkParts = extractArtifactLinks(artifacts);

  // Footer: artifacts + status link + status
  const footer: string[] = [];
  if (linkParts.length) footer.push(linkParts.join(" \u2022 "));
  if (worktreeId) footer.push(`<${sessionUrl(worktreeId)}|status>`);
  footer.push(`_${status}_`);
  parts.push(footer.join("  \u2502  "));

  return parts.join("\n");
}

/** Add or swap a Slack reaction on a message. */
async function setReaction(channel: string, ts: string, emoji: string, removeEmoji?: string): Promise<void> {
  const creds = getHostCreds({ slackChannel: channel, slackMessageTs: ts });
  if (removeEmoji) {
    await creds.slack.removeReaction(removeEmoji, { channel, timestamp: ts }).catch(() => {});
  }
  await creds.slack.addReaction(emoji, { channel, timestamp: ts }).catch(() => {});
}

export async function updateSlackStatus(
  channel: string, messageTs: string, status: string, logUrl: string,
  worktreeId: string | undefined, store: WorktreeStore, prompt: string,
  logId?: string,
): Promise<void> {
  // Build from activity log — never read back from Slack
  const activity = worktreeId ? store.readActivity(worktreeId).reverse() : []; // oldest first

  // Auto-set workspace name and tags from activity
  if (worktreeId) {
    const nameEntry = activity.find(a => a.type === "name");
    if (nameEntry?.text) {
      const meta = store.getWorktreeMeta(worktreeId);
      if (!meta.name) store.setWorktreeName(worktreeId, nameEntry.text);
    }
    const tagEntry = activity.find(a => a.type === "tag");
    if (tagEntry?.text) {
      const existing = store.getWorktreeTags(worktreeId);
      if (!existing.includes(tagEntry.text)) {
        store.setWorktreeTags(worktreeId, [...existing, tagEntry.text]);
      }
    }
  }

  const text = buildSlackStatusFromActivity(activity, prompt, status, logUrl, worktreeId, logId);

  const creds = getHostCreds({ slackChannel: channel, slackMessageTs: messageTs });
  await creds.slack.updateMessage(text, { channel, ts: messageTs });

  // Swap reaction: running → done
  const isSuccess = status.startsWith("completed");
  const emoji = isSuccess ? "white_check_mark" : "warning";
  await setReaction(channel, messageTs, emoji, "hourglass_flowing_sand");
}

export async function handleTerminalCommand(
  cmd: string, channel: string, threadTs: string, isReply: boolean,
  respond: (msg: any) => Promise<any>,
  store: WorktreeStore,
): Promise<boolean> {
  const m = cmd.match(/^terminal(?:\s+(.+))?$/i);
  if (!m) return false;

  const arg = (m[1] || "").trim();
  let hash: string | null = null;
  let session: RunMeta | null = null;

  if (arg) {
    const urlHash = extractHashFromUrl(arg);
    if (urlHash) {
      hash = urlHash;
    } else if (/^[a-f0-9]{32}$/.test(arg)) {
      hash = arg;
    }
    if (hash) session = store.findByHash(hash);
  }

  if (!session && isReply) {
    session = store.findLastInThread(channel, threadTs);
    if (session) hash = session._log_id || null;
  }

  if (!session || !hash) {
    await respond({ text: "No session found. Usage: `terminal` (in thread) or `terminal <hash>`", thread_ts: threadTs });
    return true;
  }

  const wtId = session.worktree_id || hash;
  const url = sessionUrl(wtId);
  const statusEmoji = session.status === "completed" && session.exit_code === 0 ? ":white_check_mark:" : ":warning:";
  await respond({
    text: `${statusEmoji} <${url}|View session>\nWorkspace \`${wtId.slice(0, 8)}\` \u2014 ${session.status}${session.exit_code != null ? ` (exit ${session.exit_code})` : ""}`,
    thread_ts: threadTs,
  });
  return true;
}

/** Drain queued Slack messages for a worktree and auto-resume if any exist. */
async function drainQueueAndResume(
  client: any, channel: string, threadTs: string | null,
  worktreeId: string, store: WorktreeStore, docker: DockerService,
  baseBranch: string, channelName: string,
): Promise<void> {
  try {
    const session = store.findByWorktreeId(worktreeId);
    if (!session?._log_id) return;
    const queued = store.drainQueue(session._log_id);

    if (queued.length) {
      const combined = queued.map(q => `[${q.user}]: ${q.text}`).join("\n\n");
      console.log(`[QUEUE] Draining ${queued.length} queued message(s) for worktree ${worktreeId}`);
      startReplySession(
        client, channel, threadTs, combined, session,
        queued[0].user, store, docker, baseBranch, false, channelName, false, session.profile || "",
      );
      return;
    }

    // No user messages queued — check for profile summary prompt (only on first session, not on resumes)
    const profile = session.profile || "";
    const sessions = store.listByWorktree(worktreeId);
    const isFirstSession = sessions.length <= 1;
    if (profile && isFirstSession) {
      const summaryPrompt = await getSummaryPrompt(profile);
      if (summaryPrompt) {
        console.log(`[SUMMARY] Queueing summary prompt for worktree ${worktreeId} (profile=${profile})`);
        startReplySession(
          client, channel, threadTs, summaryPrompt, session,
          "system", store, docker, baseBranch, true, channelName, false, profile,
        );
      }
    }
  } catch (e: any) {
    console.error(`[QUEUE] Failed to drain queue for ${worktreeId}: ${e.message}`);
  }
}

export async function startNewSession(
  client: any,
  channel: string,
  threadTs: string | null,
  prompt: string,
  threadContext: string,
  userName: string,
  store: WorktreeStore,
  docker: DockerService,
  baseBranch = "next",
  quiet = false,
  channelName = "",
  ciAllow = false,
  profile = "",
) {
  let status = "ClaudeBox starting\u2026";
  try {
    const postArgs: any = { channel, text: status };
    if (threadTs) postArgs.thread_ts = threadTs;
    const result = await client.chat.postMessage(postArgs);
    const messageTs = result.ts;
    if (!threadTs) threadTs = messageTs;

    // Add running reaction
    setReaction(channel, messageTs, "hourglass_flowing_sand");

    let fullPrompt = "";
    if (prompt) fullPrompt += prompt;
    if (threadContext) fullPrompt += `\n\nSlack thread context (recent):\n${threadContext}`;

    let capturedLogUrl = "";
    let capturedWorktreeId = "";

    docker.runContainerSession({
      prompt: fullPrompt,
      userName,
      slackChannel: channel,
      slackChannelName: channelName,
      slackThreadTs: threadTs!,
      slackMessageTs: messageTs,
      targetRef: toTargetRef(baseBranch),
      quiet,
      ciAllow,
      profile: profile || undefined,
    }, store, undefined, (logUrl, worktreeId) => {
      capturedLogUrl = logUrl;
      capturedWorktreeId = worktreeId;
      if (threadTs) store.bindThread(channel, threadTs, worktreeId);
      client.chat.update({ channel, ts: messageTs, text: `_working\u2026_ <${sessionUrl(worktreeId)}|status>` }).catch(() => {});
    }).then((exitCode) => {
      const latestSession = capturedWorktreeId ? store.findByWorktreeId(capturedWorktreeId) : null;
      const capturedLogId = latestSession?._log_id || "";
      if (messageTs && capturedLogUrl) {
        const statusSuffix = exitCode === 0 ? "completed" : `error (exit ${exitCode})`;
        updateSlackStatus(channel, messageTs, statusSuffix, capturedLogUrl, capturedWorktreeId, store, prompt, capturedLogId)
          .catch((e) => console.warn(`[WARN] Slack status update failed: ${e}`));
      }
      if (capturedWorktreeId) {
        drainQueueAndResume(client, channel, threadTs, capturedWorktreeId, store, docker, baseBranch, channelName);
      }
    });
  } catch (e) {
    console.error(`[ERROR] Failed to post status: ${e}`);
  }
}

export async function startReplySession(
  client: any,
  channel: string,
  threadTs: string | null,
  message: string,
  session: RunMeta,
  userName: string,
  store: WorktreeStore,
  docker: DockerService,
  baseBranch = "next",
  quiet = false,
  channelName = "",
  ciAllow = false,
  profile = "",
) {
  const worktreeId = session.worktree_id;
  if (threadTs && worktreeId) store.bindThread(channel, threadTs, worktreeId);

  // Fetch thread context so the agent understands the conversation
  const threadContext = threadTs ? await getThreadContext(client, channel, threadTs) : "";

  try {
    const postArgs: any = { channel, text: "ClaudeBox replying\u2026" };
    if (threadTs) postArgs.thread_ts = threadTs;
    const result = await client.chat.postMessage(postArgs);
    const messageTs = result.ts;

    // Add running reaction
    setReaction(channel, messageTs, "hourglass_flowing_sand");

    let fullPrompt = "";
    if (message) fullPrompt += message;
    if (threadContext) fullPrompt += `\n\nSlack thread context (recent):\n${threadContext}`;

    let capturedLogUrl = "";
    let capturedWorktreeId = "";

    docker.runContainerSession({
      prompt: fullPrompt || message,
      userName,
      slackChannel: channel,
      slackChannelName: channelName,
      slackThreadTs: threadTs!,
      slackMessageTs: messageTs,
      worktreeId,
      targetRef: toTargetRef(baseBranch),
      quiet,
      ciAllow,
      profile: profile || undefined,
    }, store, undefined, (logUrl, wtId) => {
      capturedLogUrl = logUrl;
      capturedWorktreeId = wtId;
      client.chat.update({ channel, ts: messageTs, text: `_working\u2026_ <${sessionUrl(wtId)}|status>` }).catch(() => {});
    }).then((exitCode) => {
      const latestSession = capturedWorktreeId ? store.findByWorktreeId(capturedWorktreeId) : null;
      const capturedLogId = latestSession?._log_id || "";
      if (messageTs && capturedLogUrl) {
        const statusSuffix = exitCode === 0 ? "completed" : `error (exit ${exitCode})`;
        updateSlackStatus(channel, messageTs, statusSuffix, capturedLogUrl, capturedWorktreeId, store, message, capturedLogId)
          .catch((e) => console.warn(`[WARN] Slack status update failed: ${e}`));
      }
      if (capturedWorktreeId) {
        drainQueueAndResume(client, channel, threadTs, capturedWorktreeId, store, docker, baseBranch, channelName);
      }
    });
  } catch (e) {
    console.error(`[ERROR] Failed to post reply status: ${e}`);
  }
}
