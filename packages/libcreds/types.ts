/**
 * libcreds — Centralized credential management for ClaudeBox.
 *
 * Core types: danger levels, session context, operation definitions,
 * audit log entries, and profile credential grants.
 *
 * EXPLICITLY OUT OF SCOPE:
 * - Anthropic API keys / Claude Code subscription management
 * - Redis/SSH credential proxying (handled by libaztec-packages)
 * - Credential rotation / expiry management
 * - Rate limiting for external APIs
 */

// ── Danger Levels ────────────────────────────────────────────────
// Every credentialed operation is tagged with exactly one danger level.
// Profiles must explicitly grant operations at each level they need.

export type DangerLevel = "read" | "write" | "destructive";

export const DANGER_LEVELS: Record<DangerLevel, { order: number; description: string }> = {
  read:        { order: 0, description: "Read-only operations (GET, list, fetch)" },
  write:       { order: 1, description: "Creates or updates resources (POST, PUT, PATCH)" },
  destructive: { order: 2, description: "Deletes resources, force-pushes, closes PRs/issues" },
};

// ── Service Identifiers ──────────────────────────────────────────

export type ServiceName = "github" | "slack" | "linear";

// ── Session Context (immutable after creation) ───────────────────
// Captures the triggering context. All credential operations are
// scoped to this context by default.

export interface SessionContext {
  /** Unique session identifier */
  sessionId: string;
  /** Profile name (e.g., "default", "barretenberg-audit") */
  profile: string;
  /** User who triggered the session */
  user: string;
  /** Where we're running: host has raw tokens, sidecar proxies through host */
  runtime: "host" | "sidecar";

  // Slack context (may be empty if not Slack-triggered)
  slackChannel?: string;
  slackThreadTs?: string;
  slackMessageTs?: string;

  // GitHub context (may be empty if not GitHub-triggered)
  githubRepo?: string;
  githubCommentId?: string;
  githubRunCommentId?: string;
  githubRunUrl?: string;
  githubLink?: string;

  // Metadata
  logId?: string;
  logUrl?: string;
  worktreeId?: string;
  baseBranch?: string;
}

// ── Audit Log Entry ──────────────────────────────────────────────
// Written to session JSONL. Never contains tokens or secrets.

export interface AuditEntry {
  ts: string;
  type: "cred_access";
  service: ServiceName;
  operation: string;
  danger: DangerLevel;
  /** Sanitized description (e.g., "GET repos/org/repo/issues") */
  detail: string;
  /** Whether the operation was allowed */
  allowed: boolean;
  /** If blocked, the reason */
  reason?: string;
  /** Session context identifiers */
  sessionId: string;
  logId?: string;
}

// ── Profile Credential Grants ────────────────────────────────────
// Each profile declares what operations it needs and which repos/channels
// are allowed. libcreds enforces these at call time.

export interface GitHubGrant {
  /** Repos this profile can access (e.g., ["AztecProtocol/aztec-packages"]) */
  repos: string[];
  /** Additional repos for read-only access */
  readOnlyRepos?: string[];
  /** Operations allowed at each danger level */
  operations: GitHubOperationName[];
}

export interface SlackGrant {
  /** Additional channels beyond the session thread (session thread is always allowed) */
  extraChannels?: string[];
  /** Operations allowed */
  operations: SlackOperationName[];
}

export interface LinearGrant {
  /** Operations allowed (read is always allowed) */
  operations: LinearOperationName[];
  /** Team keys allowed for write operations */
  allowedTeams?: string[];
}

export interface ProfileGrant {
  github?: GitHubGrant;
  slack?: SlackGrant;
  linear?: LinearGrant;
}

// ── GitHub Operations ────────────────────────────────────────────

export type GitHubOperationName =
  // read
  | "github:issues:read"
  | "github:pulls:read"
  | "github:contents:read"
  | "github:actions:read"
  | "github:commits:read"
  | "github:branches:read"
  | "github:gists:read"
  | "github:users:read"
  | "github:search"
  // write
  | "github:issues:create"
  | "github:issues:comment"
  | "github:issues:label"
  | "github:pulls:create"
  | "github:pulls:update"
  | "github:contents:write"
  | "github:gists:create"
  | "github:git:push"
  | "github:refs:create"
  // destructive
  | "github:issues:close"
  | "github:pulls:close"
  | "github:git:force-push";

// ── Slack Operations ─────────────────────────────────────────────

export type SlackOperationName =
  // read
  | "slack:conversations:replies"
  | "slack:users:list"
  | "slack:conversations:info"
  // write
  | "slack:chat:postMessage"
  | "slack:chat:update"
  | "slack:reactions:add"
  | "slack:reactions:remove"
  | "slack:conversations:open"
  // destructive (none currently)
  ;

// ── Linear Operations ────────────────────────────────────────────

export type LinearOperationName =
  // read
  | "linear:issues:read"
  // write
  | "linear:issues:create";

// ── Operation Metadata ───────────────────────────────────────────

export interface OperationMeta {
  name: string;
  service: ServiceName;
  danger: DangerLevel;
  description: string;
}

// ── Credential Token Source ──────────────────────────────────────
// Abstraction over where tokens come from (env vars vs proxy)

export interface TokenSource {
  github(): string;
  slack(): string;
  linear(): string;
  /** Server token for sidecar→host proxy communication */
  serverToken(): string;
  serverUrl(): string;
}
