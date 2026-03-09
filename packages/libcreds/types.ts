/**
 * libcreds core types.
 *
 * SECURITY NOTE: Fields marked [POLICY] drive access control decisions.
 * Everything else is operational metadata for audit logging and defaults.
 */

// ── Fundamentals ──────────────────────────────────────────────────

/** Access level — tagged on every credentialed operation for audit. */
export type AccessLevel = "read" | "write" | "destructive";

export type ServiceName = "github" | "slack" | "linear";

// ── Session Context ───────────────────────────────────────────────

export interface SessionContext {
  /** [POLICY] Profile name — determines the grant. */
  profile: string;
  /** [POLICY] Host has raw tokens; sidecar proxies through host. */
  runtime: "host" | "sidecar";
  /** [POLICY] Slack channel this session is scoped to. */
  slackChannel?: string;

  // ── Operational (audit logging + default targeting) ──
  sessionId: string;
  user: string;
  slackThreadTs?: string;
  slackMessageTs?: string;
  logId?: string;

  // ── Metadata (passed through for callers, not used by libcreds) ──
  githubRepo?: string;
  githubCommentId?: string;
  githubRunCommentId?: string;
  githubRunUrl?: string;
  githubLink?: string;
  logUrl?: string;
  worktreeId?: string;
  baseBranch?: string;
}

// ── Profile Grants ────────────────────────────────────────────────
// Each profile declares what resources it can access.
// libcreds enforces these at call time — no implicit permissions.

export interface GitHubGrant {
  /** Repos with full (read + write) access. */
  repos: string[];
  /** Repos with read-only access. */
  readOnlyRepos?: string[];
  /** Allow closing issues/PRs. */
  canClose?: boolean;
  /** Allow force-pushing. */
  canForcePush?: boolean;
}

export interface SlackGrant {
  /** Additional channels beyond the session channel. */
  extraChannels?: string[];
}

export interface LinearGrant {
  /** Allow creating issues (default: read-only). */
  canWrite?: boolean;
  /** Teams allowed for write operations. */
  allowedTeams?: string[];
}

export interface ProfileGrant {
  github?: GitHubGrant;
  slack?: SlackGrant;
  linear?: LinearGrant;
}

// ── Audit Entry ───────────────────────────────────────────────────

export interface AuditEntry {
  ts: string;
  service: ServiceName;
  level: AccessLevel;
  detail: string;
  allowed: boolean;
  reason?: string;
  profile: string;
  sessionId: string;
  logId?: string;
}
