/**
 * Slack credential client.
 *
 * Every Slack API call goes through this module.
 * Channel-scoped: write operations are locked to the session channel
 * (or explicitly granted extra channels). No escape hatches.
 *
 * TRUST MODEL: In sidecar mode, policy is checked here (in the sidecar),
 * then the API call is proxied through the host's /api/internal/slack.
 * The host endpoint is a dumb pipe — the sidecar is trusted to enforce policy.
 */

import type { SessionContext, ProfileGrant } from "./types.ts";
import { audit, deny } from "./audit.ts";

export interface SlackClientOpts {
  token: string;
  ctx: SessionContext;
  grant: ProfileGrant["slack"];
  /** Sidecar mode: proxy through the host server. */
  proxy?: { serverUrl: string; serverToken: string; profile: string };
}

export class SlackClient {
  private token: string;
  private ctx: SessionContext;
  private grant: ProfileGrant["slack"];
  private proxy?: SlackClientOpts["proxy"];

  constructor(opts: SlackClientOpts) {
    this.token = opts.token;
    this.ctx = opts.ctx;
    this.grant = opts.grant;
    this.proxy = opts.proxy;
  }

  /** Whether Slack access is available (direct token or proxy). */
  get hasToken(): boolean { return !!(this.token || this.proxy); }

  // ── Grant checks ────────────────────────────────────────────────

  private requireGrant(detail: string): void {
    if (!this.grant) deny("slack", "read", detail, `no Slack grant for profile '${this.ctx.profile}'`);
  }

  /** Check that a channel is in session scope (session channel + extra channels). */
  private requireChannel(channel: string, detail: string): void {
    this.requireGrant(detail);
    const allowed = new Set<string>();
    if (this.ctx.slackChannel) allowed.add(this.ctx.slackChannel);
    if (this.grant!.extraChannels) for (const ch of this.grant!.extraChannels) allowed.add(ch);

    if (!allowed.has(channel)) {
      deny("slack", "write", detail, `channel '${channel}' not in session scope (allowed: ${[...allowed].join(", ") || "none"})`);
    }
  }

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

    this.requireChannel(channel, `conversations.replies ch=${channel}`);
    audit("slack", "read", `conversations.replies ch=${channel}`, true);
    return this.slackCall("conversations.replies", { channel, ts, ...(opts?.limit ? { limit: opts.limit } : {}) }, true);
  }

  async listUsers(limit = 200): Promise<any> {
    this.requireGrant("users.list");
    audit("slack", "read", "users.list", true);
    return this.slackCall("users.list", { limit }, true);
  }

  async getChannelInfo(channelId: string): Promise<any> {
    this.requireGrant(`conversations.info ch=${channelId}`);
    audit("slack", "read", `conversations.info ch=${channelId}`, true);
    return this.slackCall("conversations.info", { channel: channelId }, true);
  }

  // ── WRITE ───────────────────────────────────────────────────────

  async postMessage(text: string, opts?: { channel?: string; threadTs?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    if (!channel) throw new Error("[libcreds] No Slack channel in session context");

    this.requireChannel(channel, `chat.postMessage ch=${channel}`);
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

    this.requireChannel(channel, `chat.update ch=${channel}`);
    audit("slack", "write", `chat.update ch=${channel}`, true);
    return this.slackCall("chat.update", { channel, ts, text });
  }

  async addReaction(name: string, opts?: { channel?: string; timestamp?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const timestamp = opts?.timestamp || this.ctx.slackMessageTs;
    if (!channel || !timestamp) return;

    this.requireChannel(channel, `reactions.add ch=${channel}`);
    audit("slack", "write", `reactions.add ch=${channel}`, true);
    return this.slackCall("reactions.add", { channel, timestamp, name });
  }

  async removeReaction(name: string, opts?: { channel?: string; timestamp?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const timestamp = opts?.timestamp || this.ctx.slackMessageTs;
    if (!channel || !timestamp) return;

    this.requireChannel(channel, `reactions.remove ch=${channel}`);
    audit("slack", "write", `reactions.remove ch=${channel}`, true);
    return this.slackCall("reactions.remove", { channel, timestamp, name }).catch(() => {});
  }

  async openConversation(userId: string): Promise<any> {
    this.requireGrant(`conversations.open user=${userId}`);
    audit("slack", "write", `conversations.open user=${userId}`, true);
    return this.slackCall("conversations.open", { users: userId });
  }
}
