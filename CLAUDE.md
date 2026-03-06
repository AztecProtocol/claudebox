# ClaudeBox

Automated Claude Code session orchestrator — Slack bot + HTTP dashboard + Docker sandboxes.

## Architecture

```
packages/
  libclaudebox/          # Generic framework (use-case agnostic)
  claudebox-audit/       # Audit dashboard + MCP tools (repo-agnostic)
profiles/                # Aztec-specific profiles
aztec/                   # Aztec org-specific code (CI, cred proxy)
server.ts                # Entry point: wires everything together
```

### Three layers

1. **libclaudebox** — Docker sandbox orchestration, session management, MCP tool framework, Slack bot, HTTP dashboard. Zero org-specific code. Anyone can use this.
2. **claudebox-audit** — Audit dashboard, coverage tracking, quality dimensions, finding management. Works with any repo.
3. **Root / aztec/** — Aztec-specific: profiles, CI integration, credential proxy, channel mappings.

### Key files

- **`packages/libclaudebox/`**
  - `docker.ts` — Container lifecycle (parameterized)
  - `session-store.ts` — JSON file session persistence + worktree GC
  - `http-routes.ts` — HTTP API + SSE + WebSocket
  - `mcp/base.ts` — Composable MCP tool registrars for sidecars
  - `html/templates.ts` — Dashboard HTML (workspace, main, personal)
  - `profile-loader.ts` — Dynamic profile discovery
  - `profile-types.ts` — `ProfileManifest`, `DockerConfig`, `RouteRegistration`
  - `slack/` — Slack event routing and message composition
  - `config.ts` — Environment variable config
  - `stat-schemas.ts` — Extensible stat collection framework

- **`profiles/<name>/`** — Each profile has:
  - `host-manifest.ts` — Docker config, channel bindings, route extensions (host-side)
  - `mcp-sidecar.ts` — MCP tool server (runs inside Docker container)
  - `container-claude.md` — System prompt for Claude

## Profile System

Profiles run in **two contexts**:
- **Host**: `host-manifest.ts` declares Docker mounts, routes, schemas, channel bindings
- **Container**: `mcp-sidecar.ts` composes MCP tools from `libclaudebox/mcp/base.ts`

Profiles are auto-discovered by scanning `profiles/*/` for `mcp-sidecar.ts`.

## Key Patterns

- **MCP sidecar changes** take effect immediately (bind-mounted, no rebuild)
- **server.ts changes** require `systemctl --user restart claudebox-slack`
- **Dockerfile changes** require `docker build`
- **Template literal regex**: `\[` must be `\\[` inside backtick strings
- **All operations must be async** — sync calls block Slack WebSocket heartbeats

## Secrets

All secrets via environment variables. **Never hardcode secrets.**

Required: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `GH_TOKEN`, `LINEAR_API_KEY`, `CI_PASSWORD`, `CLAUDEBOX_API_SECRET`, `CLAUDEBOX_SESSION_PASS`

## Development

```bash
npm install
node --experimental-strip-types --no-warnings server.ts
```
