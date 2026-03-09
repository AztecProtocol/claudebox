/**
 * Slack credential client — high-level typed operations.
 *
 * Every Slack API call in ClaudeBox goes through this module.
 * Operations are policy-checked, session-scoped, and audit-logged.
 * Fully async.
 *
 * Session scoping: by default, chat operations are locked to the
 * Slack channel/thread that triggered the session. The policy engine
 * enforces this — see policy.ts checkSlackPolicy.
 */

import type { SessionContext, ProfileGrant, SlackOperationName } from "./types.ts";
import { checkSlackPolicy, enforce } from "./policy.ts";
import { getOperationOrThrow } from "./operations.ts";

export interface SlackClientOpts {
  token: string;
  ctx: SessionContext;
  grant: ProfileGrant["slack"];
  /** For sidecar mode: proxy through the host server */
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

  // ── Internal ───────────────────────────────────────────────────

  private async check(operation: SlackOperationName, channel?: string): Promise<void> {
    const decision = checkSlackPolicy(operation, channel, this.ctx, this.grant);
    const op = getOperationOrThrow(operation);
    await enforce(decision, "slack", operation, `${operation}${channel ? ` ch=${channel}` : ""}`, op.danger);
  }

  /**
   * Call a Slack Web API method. Handles both direct and proxied modes.
   */
  private async slackCall(method: string, args: Record<string, any>, isRead = false): Promise<any> {
    // Proxy mode: route through host server
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

    // Direct mode: call Slack API with token
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

  // ── READ operations ────────────────────────────────────────────

  /** Read thread replies. Scoped to session thread by default. */
  async getThreadReplies(opts?: { channel?: string; ts?: string; limit?: number }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const ts = opts?.ts || this.ctx.slackThreadTs;
    if (!channel) throw new Error("[libcreds] No Slack channel in session context");
    if (!ts) throw new Error("[libcreds] No Slack thread_ts in session context");

    await this.check("slack:conversations:replies", channel);
    return this.slackCall("conversations.replies", {
      channel,
      ts,
      ...(opts?.limit ? { limit: opts.limit } : {}),
    }, true);
  }

  /** List workspace users. Not channel-scoped. */
  async listUsers(limit = 200): Promise<any> {
    await this.check("slack:users:list");
    return this.slackCall("users.list", { limit }, true);
  }

  /** Get channel info. */
  async getChannelInfo(channelId: string): Promise<any> {
    await this.check("slack:conversations:info", channelId);
    return this.slackCall("conversations.info", { channel: channelId }, true);
  }

  // ── WRITE operations ───────────────────────────────────────────

  /** Post a message. Scoped to session thread by default. */
  async postMessage(text: string, opts?: { channel?: string; threadTs?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    if (!channel) throw new Error("[libcreds] No Slack channel in session context");

    await this.check("slack:chat:postMessage", channel);
    return this.slackCall("chat.postMessage", {
      channel,
      text,
      thread_ts: opts?.threadTs || this.ctx.slackThreadTs,
    });
  }

  /** Update an existing message. Scoped to session message by default. */
  async updateMessage(text: string, opts?: { channel?: string; ts?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const ts = opts?.ts || this.ctx.slackMessageTs;
    if (!channel) throw new Error("[libcreds] No Slack channel in session context");
    if (!ts) throw new Error("[libcreds] No Slack message ts in session context");

    await this.check("slack:chat:update", channel);
    return this.slackCall("chat.update", { channel, ts, text });
  }

  /** Add a reaction to a message. */
  async addReaction(name: string, opts?: { channel?: string; timestamp?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const timestamp = opts?.timestamp || this.ctx.slackMessageTs;
    if (!channel || !timestamp) return;

    await this.check("slack:reactions:add", channel);
    return this.slackCall("reactions.add", { channel, timestamp, name });
  }

  /** Remove a reaction from a message. */
  async removeReaction(name: string, opts?: { channel?: string; timestamp?: string }): Promise<any> {
    const channel = opts?.channel || this.ctx.slackChannel;
    const timestamp = opts?.timestamp || this.ctx.slackMessageTs;
    if (!channel || !timestamp) return;

    await this.check("slack:reactions:remove", channel);
    return this.slackCall("reactions.remove", { channel, timestamp, name }).catch(() => {});
  }

  /** Open a DM conversation with a user. */
  async openConversation(userId: string): Promise<any> {
    await this.check("slack:conversations:open");
    return this.slackCall("conversations.open", { users: userId });
  }

  /**
   * Generic Slack API call — for methods not wrapped above.
   * Still policy-checked against the operation name.
   */
  async call(method: string, args: Record<string, any>): Promise<any> {
    // Map Slack method name to our operation name
    const opMap: Record<string, SlackOperationName> = {
      "chat.postMessage": "slack:chat:postMessage",
      "chat.update": "slack:chat:update",
      "reactions.add": "slack:reactions:add",
      "reactions.remove": "slack:reactions:remove",
      "conversations.replies": "slack:conversations:replies",
      "conversations.open": "slack:conversations:open",
      "conversations.info": "slack:conversations:info",
      "users.list": "slack:users:list",
    };

    const op = opMap[method];
    if (!op) throw new Error(`[libcreds] Unknown Slack method: ${method}`);

    const channel = args.channel as string | undefined;
    await this.check(op, channel);

    const READ_METHODS = new Set(["conversations.replies", "users.list", "conversations.info"]);
    return this.slackCall(method, args, READ_METHODS.has(method));
  }
}
