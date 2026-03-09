/**
 * Profile grants — what each profile can access.
 *
 * Every profile MUST be declared here. There are no implicit permissions.
 * Unknown profiles fall back to MINIMAL_GRANT (read-only, no repos).
 */

import type { ProfileGrant } from "./types.ts";

// ── Profile Grants ───────────────────────────────────────────────

/** Default profile — Aztec development. */
export const DEFAULT_GRANT: ProfileGrant = {
  github: {
    repos: ["AztecProtocol/aztec-packages"],
    canForcePush: true,
  },
  slack: {},
  linear: { canWrite: true },
};

/** Barretenberg audit — access to audit repo + read-only upstream. */
export const BARRETENBERG_AUDIT_GRANT: ProfileGrant = {
  github: {
    repos: ["AztecProtocol/barretenberg-claude", "AztecProtocol/barretenberg"],
    readOnlyRepos: ["AztecProtocol/aztec-packages"],
    canClose: true,
  },
  slack: {},
  linear: {},
};

/** ClaudeBox dev — for developing ClaudeBox itself. */
export const CLAUDEBOX_DEV_GRANT: ProfileGrant = {
  github: {
    repos: ["AztecProtocol/claudebox"],
    readOnlyRepos: ["AztecProtocol/aztec-packages"],
  },
  slack: {},
  linear: {},
};

/** Minimal — read-only GitHub (no repos), basic Slack. */
export const MINIMAL_GRANT: ProfileGrant = {
  github: { repos: [] },
  slack: {},
};

/** Test profile — same as default. */
export const TEST_GRANT: ProfileGrant = {
  ...DEFAULT_GRANT,
};

/**
 * Host-side grant — used by server.ts and http-routes.ts.
 * Broader permissions because this is trusted code (not AI-prompted).
 */
export const HOST_GRANT: ProfileGrant = {
  github: {
    repos: [
      "AztecProtocol/aztec-packages",
      "AztecProtocol/barretenberg-claude",
      "AztecProtocol/claudebox",
    ],
    canForcePush: true,
  },
  slack: {},
  linear: { canWrite: true },
};

// ── Registry ──────────────────────────────────────────────────────

const PROFILE_GRANTS: Record<string, ProfileGrant> = {
  default: DEFAULT_GRANT,
  "barretenberg-audit": BARRETENBERG_AUDIT_GRANT,
  "claudebox-dev": CLAUDEBOX_DEV_GRANT,
  minimal: MINIMAL_GRANT,
  test: TEST_GRANT,
  _host: HOST_GRANT,
};

/** Get the grant for a profile. Falls back to MINIMAL_GRANT if unknown. */
export function getProfileGrant(profile: string): ProfileGrant {
  return PROFILE_GRANTS[profile] || MINIMAL_GRANT;
}

/** Register a custom profile grant (for runtime-loaded profiles). */
export function registerProfileGrant(profile: string, grant: ProfileGrant): void {
  PROFILE_GRANTS[profile] = grant;
}
