/**
 * Policy engine — determines whether a credential operation is allowed.
 *
 * Combines profile grants with session context to enforce:
 * 1. Operation must be in the profile's grant list
 * 2. Resource (repo, channel, team) must be in the allowed set
 * 3. Session context restrictions (e.g., Slack thread scoping)
 */

import type {
  SessionContext, ProfileGrant,
  GitHubOperationName, SlackOperationName, LinearOperationName,
  DangerLevel,
} from "./types.ts";
import { getOperationOrThrow } from "./operations.ts";
import { logBlocked, logCredAccess } from "./audit.ts";

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

// ── GitHub Policy ────────────────────────────────────────────────

export function checkGitHubPolicy(
  operation: GitHubOperationName,
  repo: string,
  ctx: SessionContext,
  grant: ProfileGrant["github"],
): PolicyDecision {
  const op = getOperationOrThrow(operation);

  if (!grant) {
    return deny(`No GitHub grant for profile '${ctx.profile}'`);
  }

  // Check operation is granted
  if (!grant.operations.includes(operation)) {
    return deny(`Operation '${operation}' not granted for profile '${ctx.profile}'`);
  }

  // Check repo is allowed
  const allAllowed = [...grant.repos, ...(grant.readOnlyRepos || [])];
  if (!allAllowed.includes(repo)) {
    return deny(`Repo '${repo}' not in allowed list for profile '${ctx.profile}'`);
  }

  // Read-only repos can only be used for read operations
  if (op.danger !== "read" && !grant.repos.includes(repo)) {
    if (grant.readOnlyRepos?.includes(repo)) {
      return deny(`Repo '${repo}' is read-only for profile '${ctx.profile}'`);
    }
  }

  return allow();
}

// ── Slack Policy ─────────────────────────────────────────────────

export function checkSlackPolicy(
  operation: SlackOperationName,
  channel: string | undefined,
  ctx: SessionContext,
  grant: ProfileGrant["slack"],
): PolicyDecision {
  if (!grant) {
    return deny(`No Slack grant for profile '${ctx.profile}'`);
  }

  if (!grant.operations.includes(operation)) {
    return deny(`Operation '${operation}' not granted for profile '${ctx.profile}'`);
  }

  // Channel-scoped operations must target the session's own thread or an explicitly granted channel
  const channelScopedOps: SlackOperationName[] = [
    "slack:chat:postMessage", "slack:chat:update",
    "slack:reactions:add", "slack:reactions:remove",
    "slack:conversations:replies",
  ];

  if (channelScopedOps.includes(operation) && channel) {
    const allowedChannels = new Set<string>();
    if (ctx.slackChannel) allowedChannels.add(ctx.slackChannel);
    if (grant.extraChannels) {
      for (const ch of grant.extraChannels) allowedChannels.add(ch);
    }

    if (!allowedChannels.has(channel)) {
      return deny(`Channel '${channel}' not in session scope (allowed: ${[...allowedChannels].join(", ") || "none"})`);
    }
  }

  // users.list and conversations:info are always allowed when granted (no channel scope)
  // conversations:open requires the grant but no channel restriction

  return allow();
}

// ── Linear Policy ────────────────────────────────────────────────

export function checkLinearPolicy(
  operation: LinearOperationName,
  team: string | undefined,
  ctx: SessionContext,
  grant: ProfileGrant["linear"],
): PolicyDecision {
  if (!grant) {
    return deny(`No Linear grant for profile '${ctx.profile}'`);
  }

  if (!grant.operations.includes(operation)) {
    return deny(`Operation '${operation}' not granted for profile '${ctx.profile}'`);
  }

  // Team restriction for write operations
  const op = getOperationOrThrow(operation);
  if (op.danger !== "read" && team && grant.allowedTeams) {
    if (!grant.allowedTeams.includes(team.toUpperCase())) {
      return deny(`Team '${team}' not in allowed teams for profile '${ctx.profile}'`);
    }
  }

  return allow();
}

// ── Helpers ──────────────────────────────────────────────────────

function allow(): PolicyDecision {
  return { allowed: true };
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason };
}

/**
 * Enforce a policy decision — logs and throws if denied.
 */
export async function enforce(
  decision: PolicyDecision,
  service: "github" | "slack" | "linear",
  operation: string,
  detail: string,
  danger: DangerLevel,
): Promise<void> {
  if (decision.allowed) {
    await logCredAccess({ service, operation, danger, detail, allowed: true });
  } else {
    await logBlocked(service, operation, detail, decision.reason || "denied by policy");
    throw new LibCredsError(
      `[libcreds] Denied: ${operation} — ${decision.reason}`,
      service,
      operation,
    );
  }
}

// ── Typed Error ──────────────────────────────────────────────────

export class LibCredsError extends Error {
  readonly service: string;
  readonly operation: string;

  constructor(message: string, service: string, operation: string) {
    super(message);
    this.name = "LibCredsError";
    this.service = service;
    this.operation = operation;
  }
}
