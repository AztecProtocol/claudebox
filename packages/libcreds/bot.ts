/**
 * Bot credential tier — proxied operations for container-side bot actions.
 *
 * All bot operations proxy through the host server via POST /api/internal/creds.
 * This ensures containers never hold raw Slack/GitHub tokens for bot-level ops.
 * Fully async — no sync operations.
 */

export interface BotClientOpts {
  serverUrl: string;
  serverToken: string;
  profile: string;
  sessionMeta: {
    sessionId: string;
    slackChannel?: string;
    slackThreadTs?: string;
    slackMessageTs?: string;
    githubRepo?: string;
    githubCommentId?: string;
    user?: string;
    logId?: string;
  };
}

export class BotClient {
  private serverUrl: string;
  private serverToken: string;
  private profile: string;
  private sessionMeta: BotClientOpts["sessionMeta"];

  constructor(opts: BotClientOpts) {
    this.serverUrl = opts.serverUrl;
    this.serverToken = opts.serverToken;
    this.profile = opts.profile;
    this.sessionMeta = opts.sessionMeta;
  }

  // ── Internal ───────────────────────────────────────────────────

  private async proxy(op: string, args: Record<string, any>): Promise<any> {
    const res = await fetch(`${this.serverUrl}/api/internal/creds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.serverToken}`,
        "X-ClaudeBox-Profile": this.profile,
      },
      body: JSON.stringify({ op, args, session: this.sessionMeta }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[libcreds/bot] ${op} failed (${res.status}): ${text.slice(0, 500)}`);
    }

    return res.json();
  }

  // ── Bot Operations ─────────────────────────────────────────────

  /**
   * Update the session's Slack message and GitHub comment simultaneously.
   * The host handles both updates in a single proxied call.
   */
  async updateComment(opts: {
    text: string;
    slackChannel?: string;
    slackTs?: string;
    githubRepo?: string;
    githubCommentId?: string;
  }): Promise<void> {
    await this.proxy("bot:updateComment", {
      text: opts.text,
      slackChannel: opts.slackChannel || this.sessionMeta.slackChannel,
      slackTs: opts.slackTs || this.sessionMeta.slackMessageTs,
      githubRepo: opts.githubRepo || this.sessionMeta.githubRepo,
      githubCommentId: opts.githubCommentId || this.sessionMeta.githubCommentId,
    });
  }

  /**
   * DM the session author on Slack (e.g., on session completion).
   */
  async dmAuthor(opts: { text: string; user?: string }): Promise<void> {
    const user = opts.user || this.sessionMeta.user;
    if (!user) throw new Error("[libcreds/bot] No user for dmAuthor");
    await this.proxy("bot:dmAuthor", { text: opts.text, user });
  }

  /**
   * Generic Slack API call proxied through the host.
   * For operations not covered by the higher-level methods.
   */
  async postSlack(method: string, args: Record<string, any>): Promise<any> {
    return this.proxy(`slack:${method}`, args);
  }

  /**
   * Add a reaction to a message, optionally removing a previous one.
   */
  async setReaction(
    channel: string,
    ts: string,
    emoji: string,
    removeEmoji?: string,
  ): Promise<void> {
    if (removeEmoji) {
      await this.proxy("slack:reactions.remove", {
        channel,
        timestamp: ts,
        name: removeEmoji,
      }).catch(() => {});
    }
    await this.proxy("slack:reactions.add", {
      channel,
      timestamp: ts,
      name: emoji,
    });
  }

  /**
   * Read thread replies from a Slack channel.
   */
  async getThreadContext(channel: string, threadTs: string): Promise<any> {
    return this.proxy("slack:conversations.replies", {
      channel,
      ts: threadTs,
    });
  }

  /**
   * Get channel info.
   */
  async channelInfo(channelId: string): Promise<any> {
    return this.proxy("slack:conversations.info", {
      channel: channelId,
    });
  }

  /**
   * Create a BotClient from environment variables.
   * Returns null if not in a sidecar environment.
   */
  static fromEnv(): BotClient | null {
    const serverUrl = process.env.CLAUDEBOX_SERVER_URL;
    const serverToken = process.env.CLAUDEBOX_SERVER_TOKEN;
    const profile = process.env.CLAUDEBOX_PROFILE;

    if (!serverUrl || !serverToken) return null;

    return new BotClient({
      serverUrl,
      serverToken,
      profile: profile || "default",
      sessionMeta: {
        sessionId: process.env.SESSION_UUID || process.env.CLAUDEBOX_LOG_ID || "",
        slackChannel: process.env.CLAUDEBOX_SLACK_CHANNEL,
        slackThreadTs: process.env.CLAUDEBOX_SLACK_THREAD_TS,
        slackMessageTs: process.env.CLAUDEBOX_SLACK_MESSAGE_TS,
        githubRepo: process.env.CLAUDEBOX_REPO,
        githubCommentId: process.env.CLAUDEBOX_COMMENT_ID,
        user: process.env.CLAUDEBOX_USER,
        logId: process.env.CLAUDEBOX_LOG_ID,
      },
    });
  }
}
