/**
 * Plugin system for ClaudeBox.
 *
 * A Plugin is a self-contained unit that registers event handlers and HTTP routes.
 * Plugins compose on top of shared infrastructure (Docker, SessionStore, Slack).
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SessionStore } from "./session-store.ts";
import type { DockerService } from "./docker.ts";
import type { SessionMeta, ContainerSessionOpts } from "./types.ts";

// ── Shared types ──────────────────────────────────────────────────

/** Docker sandbox configuration for a plugin/profile. */
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
  store: SessionStore;
  docker: DockerService;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>;

export interface RouteRegistration {
  method: string;
  path: string;  // Express-style path like "/audit/coverage"
  auth: "api" | "basic" | "none";
  handler: RouteHandler;
}

// ── Plugin interface ──────────────────────────────────────────────

export interface PluginContext {
  /** Register a Slack message handler. Return true to claim the event. */
  onSlackMessage(handler: (msg: SlackMessage) => Promise<boolean | void>): void;

  /** Register a Slack reaction handler. Return true to claim the event. */
  onSlackReaction(handler: (reaction: SlackReaction) => Promise<boolean | void>): void;

  /** Register an HTTP route. Path is relative to plugin mount point. */
  route(method: string, path: string, handler: RouteHandler, auth?: "api" | "basic" | "none"): void;

  /** Shared infrastructure */
  docker: DockerService;
  store: SessionStore;
}

export interface Plugin {
  name: string;

  /** Docker sandbox config */
  docker?: DockerConfig;

  /** Stat schemas this plugin provides */
  schemas?: StatSchema[];

  /** Slack channel IDs this plugin handles (for channel→profile mapping) */
  channels?: string[];

  /** Channel-specific base branch overrides */
  branchOverrides?: Record<string, string>;

  /** Environment variables this plugin requires (e.g. ["GH_TOKEN", "LINEAR_API_KEY"]) */
  requiredCredentials?: string[];

  /** Whether this plugin requires a server (can't run locally) */
  requiresServer?: boolean;

  /** Called once at startup to register handlers and routes */
  setup(ctx: PluginContext): void | Promise<void>;
}

// ── Plugin runtime ────────────────────────────────────────────────

export class PluginRuntime {
  private plugins: Plugin[] = [];
  private messageHandlers: Array<(msg: SlackMessage) => Promise<boolean | void>> = [];
  private reactionHandlers: Array<(reaction: SlackReaction) => Promise<boolean | void>> = [];
  private routes: RouteRegistration[] = [];
  docker: DockerService;
  store: SessionStore;

  constructor(docker: DockerService, store: SessionStore) {
    this.docker = docker;
    this.store = store;
  }

  async loadPlugin(plugin: Plugin): Promise<void> {
    const ctx: PluginContext = {
      onSlackMessage: (handler) => { this.messageHandlers.push(handler); },
      onSlackReaction: (handler) => { this.reactionHandlers.push(handler); },
      route: (method, path, handler, auth = "basic") => {
        this.routes.push({ method, path, auth, handler });
      },
      docker: this.docker,
      store: this.store,
    };

    await plugin.setup(ctx);
    this.plugins.push(plugin);
    console.log(`[PLUGIN] Loaded: ${plugin.name} (${this.routes.length} routes)`);
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

  /** Get all loaded plugins. */
  getPlugins(): Plugin[] {
    return this.plugins;
  }

  /** Build channel→profile map from all loaded plugins. */
  buildChannelProfileMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const p of this.plugins) {
      for (const ch of p.channels || []) map.set(ch, p.name);
    }
    return map;
  }

  /** Build channel→branch map from all loaded plugins. */
  buildChannelBranchMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const p of this.plugins) {
      for (const [ch, br] of Object.entries(p.branchOverrides || {})) map.set(ch, br);
    }
    return map;
  }

  /** Get Docker config for a plugin by name. */
  getDockerConfig(name: string): DockerConfig {
    const plugin = this.plugins.find(p => p.name === name);
    return plugin?.docker ?? {};
  }
}
