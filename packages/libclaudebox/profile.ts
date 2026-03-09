/**
 * Profile system for ClaudeBox.
 *
 * A Profile is a self-contained unit that registers event handlers and HTTP routes.
 * Profiles compose on top of shared infrastructure (Docker, WorktreeStore, Slack).
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { WorktreeStore } from "./worktree-store.ts";
import type { DockerService } from "./docker.ts";
import type { RunMeta, ContainerSessionOpts } from "./types.ts";

// ── Shared types ──────────────────────────────────────────────────

/** Docker sandbox configuration for a profile. */
export interface DockerConfig {
  /** Docker image to use (overrides global default) */
  image?: string;
  /** Mount the local .git as reference repo (default: true) */
  mountReferenceRepo?: boolean;
  /** Extra bind mounts: ["host:container:mode", ...] */
  extraBinds?: string[];
  /** Extra env vars: ["KEY=value", ...] */
  extraEnv?: string[];
}

export interface StatSchema {
  name: string;
  description: string;
  fields: Array<{ name: string; type: string; description: string }>;
}

// ── Slack event types ─────────────────────────────────────────────

export interface SlackMessage {
  channel: string;
  text: string;
  isReply: boolean;
  threadTs: string;
  userId: string;
  userName: string;
  client: any;
  respond: (msg: any) => Promise<any>;
}

export interface SlackReaction {
  reaction: string;
  channel: string;
  messageTs: string;
  userId: string;
  client: any;
}

// ── HTTP route types ──────────────────────────────────────────────

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  store: WorktreeStore;
  docker: DockerService;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>;

export interface RouteRegistration {
  method: string;
  path: string;  // Express-style path like "/audit/coverage"
  auth: "api" | "basic" | "none";
  handler: RouteHandler;
}

// ── Profile interface ─────────────────────────────────────────────

export interface ProfileContext {
  /** Register a Slack message handler. Return true to claim the event. */
  onSlackMessage(handler: (msg: SlackMessage) => Promise<boolean | void>): void;

  /** Register a Slack reaction handler. Return true to claim the event. */
  onSlackReaction(handler: (reaction: SlackReaction) => Promise<boolean | void>): void;

  /** Register an HTTP route. Path is relative to profile mount point. */
  route(method: string, path: string, handler: RouteHandler, auth?: "api" | "basic" | "none"): void;

  /** Shared infrastructure */
  docker: DockerService;
  store: WorktreeStore;
}

export interface Profile {
  name: string;

  /** Docker sandbox config */
  docker?: DockerConfig;

  /** Stat schemas this profile provides */
  schemas?: StatSchema[];

  /** Slack channel IDs this profile handles (for channel→profile mapping) */
  channels?: string[];

  /** Channel-specific base branch overrides */
  branchOverrides?: Record<string, string>;

  /** Environment variables this profile requires (e.g. ["GH_TOKEN", "LINEAR_API_KEY"]) */
  requiredCredentials?: string[];

  /** Whether this profile requires a server (can't run locally) */
  requiresServer?: boolean;

  /** Prompt appended to every session prompt (e.g. gist instructions, response style) */
  promptSuffix?: string;

  /** Build extra context to inject into the prompt (e.g. recent session history). */
  buildPromptContext?: (store: WorktreeStore) => Promise<string> | string;

  /** Prompt queued as a follow-up after session completes (e.g. "write a summary") */
  summaryPrompt?: string;

  /** Fixed tag categories for session classification (used by set_tag tool and dashboard) */
  tagCategories?: string[];

  /** Called once at startup to register handlers and routes */
  setup(ctx: ProfileContext): void | Promise<void>;
}

// ── Profile runtime ──────────────────────────────────────────────

export class ProfileRuntime {
  private profiles: Profile[] = [];
  private messageHandlers: Array<(msg: SlackMessage) => Promise<boolean | void>> = [];
  private reactionHandlers: Array<(reaction: SlackReaction) => Promise<boolean | void>> = [];
  private routes: RouteRegistration[] = [];
  docker: DockerService;
  store: WorktreeStore;

  constructor(docker: DockerService, store: WorktreeStore) {
    this.docker = docker;
    this.store = store;
  }

  async loadProfile(profile: Profile): Promise<void> {
    const ctx: ProfileContext = {
      onSlackMessage: (handler) => { this.messageHandlers.push(handler); },
      onSlackReaction: (handler) => { this.reactionHandlers.push(handler); },
      route: (method, path, handler, auth = "basic") => {
        this.routes.push({ method, path, auth, handler });
      },
      docker: this.docker,
      store: this.store,
    };

    if (profile.setup) await profile.setup(ctx);
    this.profiles.push(profile);
    console.log(`[PROFILE] Loaded: ${profile.name} (${this.routes.length} routes)`);
  }

  /** Dispatch a Slack message through handlers in registration order. */
  async dispatchMessage(msg: SlackMessage): Promise<boolean> {
    for (const handler of this.messageHandlers) {
      const claimed = await handler(msg);
      if (claimed === true) return true;
    }
    return false;
  }

  /** Dispatch a Slack reaction through handlers in registration order. */
  async dispatchReaction(reaction: SlackReaction): Promise<boolean> {
    for (const handler of this.reactionHandlers) {
      const claimed = await handler(reaction);
      if (claimed === true) return true;
    }
    return false;
  }

  /** Get all registered routes. */
  getRoutes(): RouteRegistration[] {
    return this.routes;
  }

  /** Get all loaded profiles. */
  getProfiles(): Profile[] {
    return this.profiles;
  }

}
