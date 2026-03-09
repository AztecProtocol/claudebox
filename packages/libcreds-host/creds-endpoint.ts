/**
 * Unified POST /api/internal/creds endpoint handler.
 *
 * Accepts { op, args, session } from sidecar proxy calls,
 * routes to the appropriate Slack/GitHub method via libcreds,
 * and returns the API response.
 *
 * This replaces the raw Slack/GitHub fetch calls in http-routes.ts
 * with policy-checked, audit-logged operations through libcreds.
 */

import { createHostCreds } from "../libcreds/index.ts";

interface CredsRequest {
  /** Operation name, e.g. "slack:chat:postMessage", "github:issues:comment" */
  op: string;
  /** Arguments for the operation */
  args: Record<string, any>;
  /** Session context from the sidecar */
  session?: {
    slack_channel?: string;
    slack_thread_ts?: string;
    slack_message_ts?: string;
    repo?: string;
    profile?: string;
    worktree_id?: string;
  };
}

/**
 * Handle a unified creds endpoint request.
 * Returns { ok, data?, error? }.
 */
export async function handleCredsEndpoint(body: CredsRequest): Promise<{ ok: boolean; data?: any; error?: string }> {
  const { op, args, session } = body;
  if (!op || typeof op !== "string") {
    return { ok: false, error: "op required" };
  }

  // Create a host creds instance scoped to the session context
  const creds = createHostCreds({
    slackChannel: session?.slack_channel,
    slackThreadTs: session?.slack_thread_ts,
    slackMessageTs: session?.slack_message_ts,
  });

  try {
    const [service, ...rest] = op.split(":");
    const method = rest.join(":");

    if (service === "slack") {
      return await handleSlackOp(creds, method, args);
    } else if (service === "github") {
      return await handleGitHubOp(creds, method, args, session);
    } else {
      return { ok: false, error: `unknown service: ${service}` };
    }
  } catch (e: any) {
    return { ok: false, error: e.message || "internal error" };
  }
}

async function handleSlackOp(creds: any, method: string, args: Record<string, any>): Promise<{ ok: boolean; data?: any; error?: string }> {
  // Map libcreds operation suffix to SlackClient method
  switch (method) {
    case "chat:postMessage": {
      const data = await creds.slack.postMessage(args.text, {
        channel: args.channel,
        threadTs: args.thread_ts,
      });
      return { ok: true, data };
    }
    case "chat:update": {
      const data = await creds.slack.updateMessage(args.text, {
        channel: args.channel,
        ts: args.ts,
      });
      return { ok: true, data };
    }
    case "reactions:add": {
      const data = await creds.slack.addReaction(args.name, {
        channel: args.channel,
        timestamp: args.timestamp,
      });
      return { ok: true, data };
    }
    case "reactions:remove": {
      const data = await creds.slack.removeReaction(args.name, {
        channel: args.channel,
        timestamp: args.timestamp,
      });
      return { ok: true, data };
    }
    case "conversations:replies": {
      const data = await creds.slack.getThreadReplies({
        channel: args.channel,
        ts: args.ts,
        limit: args.limit,
      });
      return { ok: true, data };
    }
    case "conversations:info": {
      const data = await creds.slack.getChannelInfo(args.channel);
      return { ok: true, data };
    }
    case "users:list": {
      const data = await creds.slack.listUsers(args.limit);
      return { ok: true, data };
    }
    case "conversations:open": {
      const data = await creds.slack.openConversation(args.users);
      return { ok: true, data };
    }
    default:
      return { ok: false, error: `unknown slack op: ${method}` };
  }
}

async function handleGitHubOp(
  creds: any,
  method: string,
  args: Record<string, any>,
  session?: CredsRequest["session"],
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const repo = args.repo || session?.repo;

  switch (method) {
    case "issues:comment": {
      if (args.comment_id) {
        const data = await creds.github.updateIssueComment(repo, args.comment_id, args.body);
        return { ok: true, data };
      }
      const data = await creds.github.addIssueComment(repo, args.issue_number, args.body);
      return { ok: true, data };
    }
    case "issues:read": {
      if (args.issue_number) {
        const data = await creds.github.getIssue(repo, args.issue_number);
        return { ok: true, data };
      }
      const data = await creds.github.listIssues(repo, args.params);
      return { ok: true, data };
    }
    case "pulls:read": {
      const data = await creds.github.getPull(repo, args.pr_number);
      return { ok: true, data };
    }
    default:
      return { ok: false, error: `unknown github op: ${method}` };
  }
}
