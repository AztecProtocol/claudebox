/**
 * Slack API client with audit logging.
 *
 * Clean wrapper — no grant checking. Security boundary is the token.
 * In sidecar mode, proxies through the host's /api/internal/slack.
 */

import type { SessionContext } from "./types.ts";
import { audit } from "./audit.ts";

export interface SlackClientOpts {
  token: string;
  ctx: SessionContext;
  proxy?: { serverUrl: string; serverToken: string; profile: string };
}

export class SlackClient {
  private token: string;
  private ctx: SessionContext;
  private proxy?: SlackClientOpts["proxy"];

  constructor(opts: SlackClientOpts) {
    this.token = opts.token;
    this.ctx = opts.ctx;
    this.proxy = opts.proxy;
  }

  get hasToken(): boolean { return !!(this.token || this.proxy); }

  // ── Transport ───────────────────────────────────────────────────

  private async slackCall(method: string, args: Record<string, any>, isRead = false): Promise<any> {
    if (this.proxy) {
      const res = await fetch(`${this.proxy.serverUrl}/api/internal/slack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.proxy.serverToken}`,
          "X-ClaudeBox-Profile": this.proxy.profile,
        },
        body: JSON.stringify({ method, args }),
      });
      if (!res.ok) throw new Error(`Slack proxy ${res.status}: ${await res.text().catch(() => "")}`);
      return res.json();
    }

    if (!this.token) throw new Error("[libcreds] No Slack token available");

    const url = isRead
      ? `https://slack.com/api/${method}?${new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString()}`
      : `https://slack.com/api/${method}`;

    const res = await fetch(url, {
      method: isRead ? "GET" : "POST",
      headers: isRead
        ? { Authorization: `Bearer ${this.token}` }
        : { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      ...(!isRead && { body: JSON.stringify(args) }),
    });

    return res.json();
  }

  // ── READ ────────────────────────────────────────────────────────

  async getThreadReplies(opts?: { channel?: string; ts?: string; limit?: number }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const ts = opts?.ts || this.ctx.slackThreadTs;
    if (!channel) throw new Error("[libcreds] No Slack channel in session context");
    if (!ts) throw new Error("[libcreds] No Slack thread_ts in session context");

    audit("slack", "read", `conversations.replies ch=${channel}`, true);
    return this.slackCall("conversations.replies", { channel, ts, ...(opts?.limit ? { limit: opts.limit } : {}) }, true);
  }

  async listUsers(limit = 200): Promise<any> {
    audit("slack", "read", "users.list", true);
    return this.slackCall("users.list", { limit }, true);
  }

  async getChannelInfo(channelId: string): Promise<any> {
    audit("slack", "read", `conversations.info ch=${channelId}`, true);
    return this.slackCall("conversations.info", { channel: channelId }, true);
  }

  // ── WRITE ───────────────────────────────────────────────────────

  async postMessage(text: string, opts?: { channel?: string; threadTs?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    if (!channel) throw new Error("[libcreds] No Slack channel in session context");

    audit("slack", "write", `chat.postMessage ch=${channel}`, true);
    return this.slackCall("chat.postMessage", {
      channel, text,
      thread_ts: opts?.threadTs || this.ctx.slackThreadTs,
    });
  }

  async updateMessage(text: string, opts?: { channel?: string; ts?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const ts = opts?.ts || this.ctx.slackMessageTs;
    if (!channel) throw new Error("[libcreds] No Slack channel in session context");
    if (!ts) throw new Error("[libcreds] No Slack message ts in session context");

    audit("slack", "write", `chat.update ch=${channel}`, true);
    return this.slackCall("chat.update", { channel, ts, text });
  }

  async addReaction(name: string, opts?: { channel?: string; timestamp?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const timestamp = opts?.timestamp || this.ctx.slackMessageTs;
    if (!channel || !timestamp) return;

    audit("slack", "write", `reactions.add ch=${channel}`, true);
    return this.slackCall("reactions.add", { channel, timestamp, name });
  }

  async removeReaction(name: string, opts?: { channel?: string; timestamp?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const timestamp = opts?.timestamp || this.ctx.slackMessageTs;
    if (!channel || !timestamp) return;

    audit("slack", "write", `reactions.remove ch=${channel}`, true);
    return this.slackCall("reactions.remove", { channel, timestamp, name }).catch(() => {});
  }

  async openConversation(userId: string): Promise<any> {
    audit("slack", "write", `conversations.open user=${userId}`, true);
    return this.slackCall("conversations.open", { users: userId });
  }
}
