/**
 * libcreds core types.
 */

/** Access level — tagged on every credentialed operation for audit. */
export type AccessLevel = "read" | "write" | "destructive";

export type ServiceName = "github" | "slack" | "linear";

/** Session context — carried by every Creds instance. */
export interface SessionContext {
  profile: string;
  runtime: "host" | "sidecar";
  sessionId: string;
  user: string;
  slackChannel?: string;
  slackThreadTs?: string;
  slackMessageTs?: string;
  logId?: string;
  githubRepo?: string;
  githubCommentId?: string;
  githubRunCommentId?: string;
  githubRunUrl?: string;
  githubLink?: string;
  logUrl?: string;
  worktreeId?: string;
  baseBranch?: string;
}

/** Audit log entry. */
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
