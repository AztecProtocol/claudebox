/**
 * Default grants — the safe defaults for each profile.
 *
 * Every profile MUST declare its grants here. There are no implicit permissions.
 * New profiles start with the MINIMAL_GRANT and add what they need.
 */

import type { ProfileGrant, GitHubOperationName, SlackOperationName, LinearOperationName } from "./types.ts";

// ── Shared operation sets ────────────────────────────────────────
// Building blocks for composing grants.

/** GitHub read operations available to all profiles with GitHub access. */
const GH_READ_OPS: GitHubOperationName[] = [
  "github:issues:read",
  "github:pulls:read",
  "github:contents:read",
  "github:actions:read",
  "github:commits:read",
  "github:branches:read",
  "github:gists:read",
  "github:users:read",
  "github:search",
];

/** GitHub write operations for profiles that create PRs and gists. */
const GH_WRITE_OPS: GitHubOperationName[] = [
  "github:issues:create",
  "github:issues:comment",
  "github:issues:label",
  "github:pulls:create",
  "github:pulls:update",
  "github:gists:create",
  "github:git:push",
  "github:refs:create",
  "github:contents:write",
];

/** Slack operations for session-scoped communication. */
const SLACK_SESSION_OPS: SlackOperationName[] = [
  "slack:conversations:replies",
  "slack:users:list",
  "slack:chat:postMessage",
  "slack:chat:update",
  "slack:reactions:add",
  "slack:reactions:remove",
  "slack:conversations:open",
];

/** Slack operations for host-side (server) use. */
const SLACK_HOST_OPS: SlackOperationName[] = [
  ...SLACK_SESSION_OPS,
  "slack:conversations:info",
];

/** Linear read-only (default for all profiles with Linear access). */
const LINEAR_READ_OPS: LinearOperationName[] = [
  "linear:issues:read",
];

/** Linear read + write. */
const LINEAR_WRITE_OPS: LinearOperationName[] = [
  "linear:issues:read",
  "linear:issues:create",
];

// ── Profile Grants ───────────────────────────────────────────────

/** Default profile — Aztec development (the main ClaudeBox use case). */
export const DEFAULT_GRANT: ProfileGrant = {
  github: {
    repos: ["AztecProtocol/aztec-packages"],
    operations: [...GH_READ_OPS, ...GH_WRITE_OPS, "github:git:force-push"],
  },
  slack: {
    operations: SLACK_SESSION_OPS,
  },
  linear: {
    operations: LINEAR_WRITE_OPS,
  },
};

/** Barretenberg audit profile — access to audit repo + upstream for external PRs. */
export const BARRETENBERG_AUDIT_GRANT: ProfileGrant = {
  github: {
    repos: ["AztecProtocol/barretenberg-claude", "AztecProtocol/barretenberg"],
    readOnlyRepos: ["AztecProtocol/aztec-packages"],
    operations: [
      ...GH_READ_OPS,
      ...GH_WRITE_OPS,
      "github:issues:close",
      "github:pulls:close",
    ],
  },
  slack: {
    operations: SLACK_SESSION_OPS,
  },
  linear: {
    operations: LINEAR_READ_OPS,
  },
};

/** ClaudeBox dev profile — for developing ClaudeBox itself. */
export const CLAUDEBOX_DEV_GRANT: ProfileGrant = {
  github: {
    repos: ["AztecProtocol/claudebox"],
    readOnlyRepos: ["AztecProtocol/aztec-packages"],
    operations: [...GH_READ_OPS, ...GH_WRITE_OPS],
  },
  slack: {
    operations: SLACK_SESSION_OPS,
  },
  linear: {
    operations: LINEAR_READ_OPS,
  },
};

/** Minimal profile — read-only GitHub, session-scoped Slack, no Linear. */
export const MINIMAL_GRANT: ProfileGrant = {
  github: {
    repos: [],
    operations: GH_READ_OPS,
  },
  slack: {
    operations: ["slack:conversations:replies", "slack:chat:postMessage", "slack:chat:update"],
  },
};

/** Test profile — same as default but isolated. */
export const TEST_GRANT: ProfileGrant = {
  ...DEFAULT_GRANT,
};

/**
 * Host-side grant — used by server.ts and http-routes.ts.
 * The host has direct access to all tokens and broader permissions
 * because it's trusted code (not user-prompted AI).
 */
export const HOST_GRANT: ProfileGrant = {
  github: {
    repos: [
      "AztecProtocol/aztec-packages",
      "AztecProtocol/barretenberg-claude",
      "AztecProtocol/claudebox",
    ],
    operations: [...GH_READ_OPS, ...GH_WRITE_OPS, "github:git:force-push"],
  },
  slack: {
    operations: SLACK_HOST_OPS,
  },
  linear: {
    operations: LINEAR_WRITE_OPS,
  },
};

// ── Grant Registry ───────────────────────────────────────────────

const PROFILE_GRANTS: Record<string, ProfileGrant> = {
  default: DEFAULT_GRANT,
  "barretenberg-audit": BARRETENBERG_AUDIT_GRANT,
  "claudebox-dev": CLAUDEBOX_DEV_GRANT,
  minimal: MINIMAL_GRANT,
  test: TEST_GRANT,
  _host: HOST_GRANT,
};

/**
 * Get the grant for a profile. Falls back to MINIMAL_GRANT if unknown.
 */
export function getProfileGrant(profile: string): ProfileGrant {
  return PROFILE_GRANTS[profile] || MINIMAL_GRANT;
}

/**
 * Register a custom profile grant (for profiles loaded at runtime).
 */
export function registerProfileGrant(profile: string, grant: ProfileGrant): void {
  PROFILE_GRANTS[profile] = grant;
}
