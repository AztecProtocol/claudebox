/**
 * libcreds-host — Server-side credential operations.
 *
 * Only used by server.ts and http-routes.ts (host-side code).
 */

import { createHostCreds, type Creds } from "../libcreds/index.ts";

export type { Creds };

export interface HostCredsOpts {
  slackChannel?: string;
  slackThreadTs?: string;
  slackMessageTs?: string;
}

/** Singleton host creds instance (no session scoping needed). */
let _hostCreds: Creds | undefined;

/** Get or create a host-side Creds instance. */
export function getHostCreds(opts?: HostCredsOpts): Creds {
  if (opts) {
    // Session-scoped: create fresh instance with channel context
    return createHostCreds(opts);
  }
  // Singleton for general-purpose host operations
  if (!_hostCreds) {
    _hostCreds = createHostCreds();
  }
  return _hostCreds;
}

// ── Token accessors for container injection ─────────────────────
// docker.ts needs raw token values to pass into container env vars.
// Only libcreds-host should read these env vars directly.

/** Get raw token values for injecting into container environments. */
export function getContainerTokens(): { ghToken: string; slackBotToken: string; linearApiKey: string } {
  return {
    ghToken: process.env.GH_TOKEN || "",
    slackBotToken: process.env.SLACK_BOT_TOKEN || "",
    linearApiKey: process.env.LINEAR_API_KEY || "",
  };
}

/** Get the Slack bot token (for Bolt App initialization). */
export function getSlackBotToken(): string {
  return process.env.SLACK_BOT_TOKEN || "";
}

// Re-export submodules
export { dmAuthor } from "./slack.ts";
export { handleCredsEndpoint } from "./creds-endpoint.ts";
