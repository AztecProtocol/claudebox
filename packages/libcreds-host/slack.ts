/**
 * Host-side Slack operations — privileged server-side helpers.
 *
 * These wrap libcreds SlackClient methods with higher-level logic
 * previously scattered across helpers.ts and http-routes.ts.
 * All methods are fully async. Uses the host Creds instance with
 * direct SLACK_BOT_TOKEN access (host is trusted).
 */

import { getHostCreds } from "./index.ts";

// Channel info cache (host-side only, never expires during process lifetime)
const channelInfoCache = new Map<string, any>();

export class HostSlack {
  /** Add or swap a Slack reaction on a message. */
  static async setReaction(channel: string, ts: string, emoji: string, removeEmoji?: string): Promise<void> {
    const creds = getHostCreds({ slackChannel: channel, slackMessageTs: ts });
    if (removeEmoji) {
      await creds.slack.removeReaction(removeEmoji, { channel, timestamp: ts }).catch(() => {});
    }
    await creds.slack.addReaction(emoji, { channel, timestamp: ts }).catch(() => {});
  }

  /** Update a Slack message. */
  static async updateMessage(channel: string, ts: string, text: string): Promise<any> {
    const creds = getHostCreds({ slackChannel: channel, slackMessageTs: ts });
    return creds.slack.updateMessage(text, { channel, ts });
  }

  /** Post a message to a channel, optionally in a thread. */
  static async postMessage(channel: string, text: string, threadTs?: string): Promise<any> {
    const creds = getHostCreds({ slackChannel: channel, slackThreadTs: threadTs });
    return creds.slack.postMessage(text, { channel, threadTs });
  }

  /** Get channel info (with in-memory caching). */
  static async getChannelInfo(channelId: string): Promise<any> {
    const cached = channelInfoCache.get(channelId);
    if (cached) return cached;
    const creds = getHostCreds();
    const result = await creds.slack.getChannelInfo(channelId);
    if (result?.channel) channelInfoCache.set(channelId, result);
    return result;
  }

  /** List workspace users. */
  static async listUsers(limit = 200): Promise<any> {
    const creds = getHostCreds();
    return creds.slack.listUsers(limit);
  }

  /** Open a DM conversation with a user. */
  static async openConversation(userId: string): Promise<any> {
    const creds = getHostCreds();
    return creds.slack.openConversation(userId);
  }

  /**
   * DM the session author on completion.
   * Full logic from the /api/internal/dm handler in http-routes.ts.
   */
  static async dmAuthor(
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
    const searchData = await HostSlack.listUsers(200);
    const slackUser = searchData.members?.find((m: any) =>
      m.real_name === session.user || m.name === session.user || m.profile?.display_name === session.user
    );
    if (!slackUser) return { ok: false, reason: "user_not_found" };

    // Open DM
    const openData = await HostSlack.openConversation(slackUser.id);
    if (!openData.ok) return { ok: false, reason: openData.error };

    // Send DM
    await HostSlack.postMessage(openData.channel.id, parts.join("\n"));
    return { ok: true, user: slackUser.id };
  }
}
