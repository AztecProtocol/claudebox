/**
 * Operation registry — maps every credentialed operation to its metadata.
 * This is the single source of truth for what operations exist and their danger levels.
 */

import type { OperationMeta, GitHubOperationName, SlackOperationName, LinearOperationName } from "./types.ts";

const OPERATIONS: OperationMeta[] = [
  // ── GitHub Read ────────────────────────────────────────────────
  { name: "github:issues:read",     service: "github", danger: "read", description: "List/get issues and comments" },
  { name: "github:pulls:read",      service: "github", danger: "read", description: "List/get pull requests, files, reviews" },
  { name: "github:contents:read",   service: "github", danger: "read", description: "Read file contents, commits, compare" },
  { name: "github:actions:read",    service: "github", danger: "read", description: "Read CI/CD workflow runs, jobs, logs" },
  { name: "github:commits:read",    service: "github", danger: "read", description: "Read commit status, check-runs" },
  { name: "github:branches:read",   service: "github", danger: "read", description: "List/get branches and refs" },
  { name: "github:gists:read",      service: "github", danger: "read", description: "List/get gists" },
  { name: "github:users:read",      service: "github", danger: "read", description: "Get user profiles" },
  { name: "github:search",          service: "github", danger: "read", description: "Search issues, code, repositories" },

  // ── GitHub Write ───────────────────────────────────────────────
  { name: "github:issues:create",   service: "github", danger: "write", description: "Create new issues" },
  { name: "github:issues:comment",  service: "github", danger: "write", description: "Add/update comments on issues" },
  { name: "github:issues:label",    service: "github", danger: "write", description: "Add/remove labels on issues" },
  { name: "github:pulls:create",    service: "github", danger: "write", description: "Create pull requests" },
  { name: "github:pulls:update",    service: "github", danger: "write", description: "Update PR title, body, base, state" },
  { name: "github:contents:write",  service: "github", danger: "write", description: "Create/update file contents via API" },
  { name: "github:gists:create",    service: "github", danger: "write", description: "Create gists" },
  { name: "github:git:push",        service: "github", danger: "write", description: "Push commits to a branch" },
  { name: "github:refs:create",     service: "github", danger: "write", description: "Create git refs (branches, tags)" },

  // ── GitHub Destructive ─────────────────────────────────────────
  { name: "github:issues:close",    service: "github", danger: "destructive", description: "Close issues" },
  { name: "github:pulls:close",     service: "github", danger: "destructive", description: "Close pull requests" },
  { name: "github:git:force-push",  service: "github", danger: "destructive", description: "Force-push to a branch (overwrites history)" },

  // ── Slack Read ─────────────────────────────────────────────────
  { name: "slack:conversations:replies", service: "slack", danger: "read", description: "Read thread replies" },
  { name: "slack:users:list",            service: "slack", danger: "read", description: "List workspace users" },
  { name: "slack:conversations:info",    service: "slack", danger: "read", description: "Get channel info" },

  // ── Slack Write ────────────────────────────────────────────────
  { name: "slack:chat:postMessage",    service: "slack", danger: "write", description: "Post a message to a channel/thread" },
  { name: "slack:chat:update",         service: "slack", danger: "write", description: "Update an existing message" },
  { name: "slack:reactions:add",       service: "slack", danger: "write", description: "Add a reaction to a message" },
  { name: "slack:reactions:remove",    service: "slack", danger: "write", description: "Remove a reaction from a message" },
  { name: "slack:conversations:open",  service: "slack", danger: "write", description: "Open a DM conversation" },

  // ── Linear Read ────────────────────────────────────────────────
  { name: "linear:issues:read",    service: "linear", danger: "read", description: "Fetch Linear issues" },

  // ── Linear Write ───────────────────────────────────────────────
  { name: "linear:issues:create",  service: "linear", danger: "write", description: "Create Linear issues" },
];

const _byName = new Map(OPERATIONS.map(op => [op.name, op]));

export function getOperation(name: string): OperationMeta | undefined {
  return _byName.get(name);
}

export function getOperationOrThrow(name: string): OperationMeta {
  const op = _byName.get(name);
  if (!op) throw new Error(`[libcreds] Unknown operation: ${name}`);
  return op;
}

export function allOperations(): OperationMeta[] {
  return [...OPERATIONS];
}

export function operationsByService(service: string): OperationMeta[] {
  return OPERATIONS.filter(op => op.service === service);
}

export function dangerLevelOf(name: GitHubOperationName | SlackOperationName | LinearOperationName): string {
  return getOperationOrThrow(name).danger;
}
