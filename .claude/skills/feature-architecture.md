---
name: feature-architecture
description: Analyze where a feature belongs across ClaudeBox's three architectural layers (libclaudebox, plugin system, per-profile). Use before implementing any feature that touches multiple layers, adding new CLI flags, new APIs, new container behavior, or new profile capabilities. Triggers on "where does this belong", "figure out the architecture", "feature architecture", or when a proposed change could live in multiple layers.
---

# ClaudeBox Feature Architecture Analysis

Analyze a proposed feature across ClaudeBox's three-layer architecture to determine what changes go where, what stays generic vs profile-specific, and what contracts need updating.

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│  CLI (cli.ts)           — User-facing flags & commands  │
├─────────────────────────────────────────────────────────┤
│  Server (server.ts)     — Wires plugins, Slack, HTTP    │
├─────────────────────────────────────────────────────────┤
│  libclaudebox/          — Generic framework primitives  │
│    types.ts             — ContainerSessionOpts, etc.    │
│    docker.ts            — Container lifecycle           │
│    config.ts            — Env vars, URL builders        │
│    http-routes.ts       — HTTP API endpoints            │
│    session-store.ts     — Persistence, worktrees        │
│    plugin.ts            — Plugin/PluginContext/Runtime   │
│    plugin-loader.ts     — Discovery + loading           │
│    mcp/base.ts          — MCP tool registrars           │
│    slack/               — Event routing                 │
├─────────────────────────────────────────────────────────┤
│  Plugin System          — Plugin interface contracts    │
│    Plugin interface     — name, setup(), docker, etc.   │
│    PluginContext        — onSlackMessage, route, etc.   │
│    PluginRuntime        — dispatch, channel maps        │
├─────────────────────────────────────────────────────────┤
│  Profiles (per-profile) — Self-contained profile code   │
│    plugin.ts            — Routes, handlers, dashboard   │
│    mcp-sidecar.ts       — Container-side MCP tools      │
│    host-manifest.ts     — Legacy: docker config only    │
│    container-claude.md  — System prompt for Claude      │
├─────────────────────────────────────────────────────────┤
│  Container Runtime      — Runs inside Docker            │
│    container-entrypoint.sh  — Launches claude CLI       │
│    container-interactive.sh — Interactive sessions      │
│    mcp-sidecar.ts           — MCP tool server           │
└─────────────────────────────────────────────────────────┘
```

## Analysis Process

For each proposed feature, work through these questions in order:

### Step 1: Classify the Feature

What kind of feature is it?

| Type | Examples | Primary layer |
|------|----------|---------------|
| **Container behavior** | Model selection, timeout, memory limits | libclaudebox/docker.ts + entrypoint |
| **Session lifecycle** | Resume, cancel, GC, binding | libclaudebox/session-store.ts |
| **User interaction** | New CLI command, new flag | cli.ts |
| **API endpoint** | New REST route | Plugin route OR http-routes.ts |
| **MCP tool** | New tool for Claude inside container | mcp/base.ts (shared) or profile sidecar |
| **Dashboard/UI** | New page, new widget | Plugin HTML or shared html/ |
| **Slack behavior** | New reaction handler, channel logic | Plugin handler or slack/handlers.ts |
| **Profile capability** | Audit-specific, org-specific | Profile plugin.ts |

### Step 2: Apply the Layering Rules

**Rule 1: Generic vs Specific**
- If ANY profile could use it → libclaudebox
- If only ONE profile needs it → that profile's plugin
- If it's a MECHANISM (how) → libclaudebox
- If it's a POLICY (what/when) → plugin

**Rule 2: Data Flow Direction**
Trace the feature's data flow through the stack:
```
CLI flag → POST /run body → ContainerSessionOpts → docker env → entrypoint → claude args
```
Every hop in this chain needs the field added. Missing a hop = silent data loss.

**Rule 3: Plugin Interface Changes**
If a feature needs new PluginContext methods:
- Add to `PluginContext` interface in plugin.ts
- Implement in `PluginRuntime`
- All plugins get it, none are forced to use it

**Rule 4: Container Boundary**
The container is a hard boundary. Data crosses it via:
- Environment variables (host → container)
- Bind-mounted files (bidirectional)
- MCP tool calls (container → sidecar → host)
- HTTP to host.docker.internal (container → host)

New data that Claude needs inside the container MUST use one of these channels.

### Step 3: Map Changes Per Layer

Fill in this template:

```
Feature: <name>
Purpose: <one line>

── libclaudebox (generic framework) ──
  types.ts:              <new fields on ContainerSessionOpts, SessionMeta, etc.>
  docker.ts:             <new env vars, mount points, container args>
  config.ts:             <new env var constants>
  http-routes.ts:        <new/modified endpoints>
  session-store.ts:      <persistence changes>
  plugin.ts:             <new PluginContext methods>
  mcp/base.ts:           <new shared MCP tools>
  slack/:                <handler changes>

── Plugin system (contracts) ──
  Plugin interface:      <new fields>
  PluginContext:          <new methods>
  PluginRuntime:          <new dispatch logic>

── Per-profile changes ──
  profiles/X/plugin.ts:       <new routes, handlers>
  profiles/X/mcp-sidecar.ts:  <new MCP tools>
  profiles/X/container-claude.md: <prompt changes>

── CLI ──
  cli.ts:                <new flags, commands>

── Container runtime ──
  container-entrypoint.sh:    <new env reads, claude args>
  container-interactive.sh:   <interactive session changes>

── Server ──
  server.ts:             <wiring changes>

── Tests ──
  tests/libclaudebox/:   <unit tests>
  tests/integration/:    <integration tests>
  tests/manual/:         <manual test additions>
```

### Step 4: Verify Contracts

Check these contracts aren't broken:

1. **POST /run body** → must be documented if new fields added
2. **ContainerSessionOpts** → must match what docker.ts reads
3. **Docker env vars** → must match what entrypoint reads
4. **Plugin interface** → existing plugins must not break (additive only)
5. **MCP tool schema** → must be backward compatible
6. **Session metadata** → old sessions must still load (no required new fields)

### Step 5: Migration Check

- Does this need a Dockerfile rebuild? (new packages, new binaries)
- Does this need a server restart? (server.ts, libclaudebox changes)
- Is it hot-reloadable? (sidecar changes are bind-mounted)
- Does it need data migration? (session store format changes)

## Example: `--model` Flag

```
Feature: --model
Purpose: Let CLI users choose which Claude model runs in the container

── libclaudebox ──
  types.ts:          Add `model?: string` to ContainerSessionOpts
  docker.ts:         Pass CLAUDEBOX_MODEL env var to Claude container
  http-routes.ts:    Read `body.model` in POST /run, pass to runContainerSession

── Plugin system ──
  (no changes — model is orthogonal to plugins)

── Per-profile ──
  (no changes — any profile can use any model)

── CLI ──
  cli.ts:            Add --model flag, pass in POST body and local opts

── Container runtime ──
  container-entrypoint.sh:  Read CLAUDEBOX_MODEL, append --model to claude args

── Tests ──
  tests/manual/:     Update test script to verify --model in help output
```

This example shows a clean "pass-through" feature: every layer just forwards it, no branching logic needed.

## Anti-patterns

- **Don't put profile-specific code in libclaudebox.** If you're writing `if (profile === "audit")` in generic code, it belongs in the plugin.
- **Don't add PluginContext methods for one-off needs.** Use the existing `route()` and `onSlackMessage()` — they're general enough for most things.
- **Don't skip hops in the data chain.** If a CLI flag doesn't reach the container, it silently does nothing.
- **Don't make Plugin interface changes that break existing plugins.** All new fields must be optional.
