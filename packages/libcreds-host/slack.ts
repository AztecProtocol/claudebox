/**
 * Host-side Slack helpers — complex multi-step operations only.
 *
 * Simple Slack calls should use getHostCreds().slack.* directly.
 * This module exists only for operations with real logic beyond
 * a single API call (e.g., dmAuthor does user lookup + DM open + send).
 */

import { getHostCreds } from "./index.ts";

/**
 * DM the session author on completion.
 * Multi-step: list users → find match → open DM → send message.
 */
export async function dmAuthor(
  session: {
    user?: string;
    slack_channel?: string;
    slack_thread_ts?: string;
    slack_message_ts?: string;
    worktree_id?: string;
    link?: string;
    host?: string;
  },
  status: string,
  trackedPRs?: { url: string; num: number; title?: string; action?: string }[],
): Promise<{ ok: boolean; reason?: string; user?: string }> {
  if (!session?.user) return { ok: false, reason: "no_user" };
  if (session.slack_channel?.startsWith("D")) return { ok: false, reason: "already_dm" };

  const parts: string[] = [];
  const contextLinks: string[] = [];

  if (session.slack_channel && session.slack_thread_ts) {
    const slackDomain = process.env.SLACK_WORKSPACE_DOMAIN || "slack";
    const threadLink = `https://${slackDomain}.slack.com/archives/${session.slack_channel}/p${session.slack_thread_ts.replace(".", "")}`;
    contextLinks.push(`<${threadLink}|thread>`);
  }
  if (session.link) contextLinks.push(`<${session.link}|source>`);

  const prLinks = (trackedPRs || []).map((pr) => `<${pr.url}|#${pr.num}>`);
  parts.push((status || "Task done") + (prLinks.length ? ` ${prLinks.join(" ")}` : ""));

  const footer: string[] = [...contextLinks];
  const host = session.host || "claudebox.work";
  if (session.worktree_id) footer.push(`<https://${host}/s/${session.worktree_id}|status>`);
  if (footer.length) parts.push(footer.join(" \u2502 "));

  // Find user
  const creds = getHostCreds();
  const searchData = await creds.slack.listUsers(200);
  const slackUser = searchData.members?.find((m: any) =>
    m.real_name === session.user || m.name === session.user || m.profile?.display_name === session.user
  );
  if (!slackUser) return { ok: false, reason: "user_not_found" };

  // Open DM
  const openData = await creds.slack.openConversation(slackUser.id);
  if (!openData.ok) return { ok: false, reason: openData.error };

  // Send DM
  const dmCreds = getHostCreds({ slackChannel: openData.channel.id });
  await dmCreds.slack.postMessage(parts.join("\n"), { channel: openData.channel.id });
  return { ok: true, user: slackUser.id };
}
