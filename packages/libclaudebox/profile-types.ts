import type { IncomingMessage, ServerResponse } from "http";
import type { SessionMeta } from "./types.ts";

/**
 * Docker sandbox configuration for a profile.
 */
export interface DockerConfig {
  /** Mount the local .git as reference repo (default: true) */
  mountReferenceRepo?: boolean;
  /** Extra bind mounts: ["host:container:mode", ...] */
  extraBinds?: string[];
  /** Extra env vars: ["KEY=value", ...] */
  extraEnv?: string[];
}

/**
 * HTTP route handler context.
 */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>;

export interface RouteRegistration {
  method: string;
  pattern: RegExp;
  auth: "api" | "basic" | "none";
  handler: RouteHandler;
}

export interface StatSchema {
  name: string;
  description: string;
  fields: Array<{ name: string; type: string; description: string }>;
}

/**
 * Server-side extensions for a profile.
 * Routes are mounted at /api/profiles/<name>/* on the host server.
 */
export interface ProfileServer {
  /** HTTP routes — mounted at /api/profiles/<name>/ */
  routes?: () => RouteRegistration[];
  /** Called when a session starts for this profile */
  onSessionStart?: (session: SessionMeta) => Promise<void>;
  /** Called when a session ends for this profile */
  onSessionEnd?: (session: SessionMeta) => Promise<void>;
}

/**
 * Host-side profile manifest. Every profile directory exports this as default
 * from host-manifest.ts.
 */
export interface ProfileManifest {
  /** Profile name — must match directory name */
  name: string;
  /** Docker sandbox config */
  docker?: DockerConfig;
  /** Server-side extensions (routes, lifecycle hooks) */
  server?: ProfileServer;
  /** Stat schemas to register */
  schemas?: StatSchema[];
  /** Slack channel IDs that default to this profile */
  channels?: string[];
  /** Channel-specific base branch overrides */
  branchOverrides?: Record<string, string>;
  /** Whether this profile requires a claudebox server (e.g. for Slack, audit endpoints) */
  requiresServer?: boolean;
}
