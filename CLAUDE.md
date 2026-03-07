# ClaudeBox

Automated Claude Code session orchestrator — Slack bot + HTTP dashboard + Docker sandboxes.

## Architecture

```
packages/
  libclaudebox/          # Generic framework (use-case agnostic)
profiles/                # Profiles (plugin.ts + mcp-sidecar.ts)
aztec/                   # Aztec org-specific code (CI, cred proxy)
server.ts                # Entry point: wires everything together
```

### Key files

- **`packages/libclaudebox/`**
  - `plugin.ts` — Plugin interface, PluginRuntime, DockerConfig, StatSchema types
  - `plugin-loader.ts` — Plugin discovery and loading from profiles/ directory
  - `docker.ts` — Container lifecycle (parameterized by DockerConfig)
  - `session-store.ts` — JSON file session persistence + worktree GC
  - `http-routes.ts` — HTTP API + SSE + WebSocket + plugin route mounting
  - `mcp/base.ts` — Composable MCP tool registrars for sidecars
  - `html/templates.ts` — Dashboard HTML (workspace, main, personal)
  - `slack/` — Slack event routing and message composition
  - `config.ts` — Environment variable config
  - `stat-schemas.ts` — Extensible stat collection framework (register/query)
  - `settings.ts` — User settings (~/.claude/claudebox/settings.json)

- **`profiles/<name>/`** — Each profile has:
  - `plugin.ts` — Plugin config: Docker settings, channels, schemas, routes
  - `mcp-sidecar.ts` — MCP tool server (runs inside Docker container)
  - `container-claude.md` — System prompt for Claude

## Plugin System

Plugins run in **two contexts**:
- **Host**: `plugin.ts` declares Docker config, channels, routes, schemas, credentials
- **Container**: `mcp-sidecar.ts` composes MCP tools from `libclaudebox/mcp/base.ts`

Profiles are auto-discovered by scanning `profiles/*/` for `plugin.ts` or `mcp-sidecar.ts`.

## Key Patterns

- **MCP sidecar changes** take effect immediately (bind-mounted, no rebuild)
- **server.ts changes** require `systemctl --user restart claudebox`
- **Dockerfile changes** require `docker build`
- **Template literal regex**: `\[` must be `\\[` inside backtick strings
- **All operations must be async** — sync calls block Slack WebSocket heartbeats

## Secrets

All secrets via environment variables. **Never hardcode secrets.**

Required: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `GH_TOKEN`, `CLAUDEBOX_API_SECRET`, `CLAUDEBOX_SESSION_PASS`
Optional: `LINEAR_API_KEY`, `CI_PASSWORD`

## Development

```bash
npm install
CLAUDEBOX_SESSION_PASS=dev CLAUDEBOX_HTTP_ONLY=1 node --experimental-strip-types --no-warnings server.ts --http-only
```

## Deployment

```bash
# Install as systemd user service
./scripts/setup-systemd.sh

# View logs
journalctl --user -u claudebox -f

# Restart after changes
systemctl --user restart claudebox
```
