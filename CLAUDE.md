# ClaudeBox

Docker container orchestrator for Claude agents. Slack + HTTP + CLI.

## Concepts

- **Worktree** — persistent workspace (git checkout + transcripts + metadata). Survives across runs.
- **Run** — one Claude execution in a worktree. Identified by `<worktreeId>-<seq>`.
- **Profile** — directory in `profiles/` with plugin config, MCP sidecar, and system prompt.
- **Host/container boundary** — host owns Slack/GitHub context; containers talk back via internal HTTP API on `:3002`.

## Layout

```
packages/libclaudebox/     # Framework (Docker, sessions, MCP, Slack, HTTP)
  plugin.ts                # Plugin interface, PluginRuntime
  plugin-loader.ts         # Profile discovery and loading
  docker.ts                # Container lifecycle
  session-store.ts         # Worktree + run persistence, GC
  http-routes.ts           # HTTP API, dashboard, plugin routes
  server-client.ts         # Container→host HTTP client
  mcp/                     # MCP tool modules (env, activity, tools, git-tools, server)
  html/                    # Dashboard templates
  slack/                   # Slack event routing
profiles/<name>/           # Profiles: plugin.ts + mcp-sidecar.ts + container-claude.md
server.ts                  # Entry point
cli.ts                     # CLI client
```

## Key Patterns

- MCP sidecar changes take effect immediately (bind-mounted)
- server.ts / plugin.ts changes require `systemctl --user restart claudebox`
- Template literal regex: `\[` must be `\\[` inside backtick strings
- All operations must be async — sync calls block Slack heartbeats

## Secrets

All via environment variables. Never hardcode.

Required: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `GH_TOKEN`, `CLAUDEBOX_API_SECRET`, `CLAUDEBOX_SESSION_PASS`
Optional: `LINEAR_API_KEY`

## Development

```bash
npm install
CLAUDEBOX_SESSION_PASS=dev CLAUDEBOX_HTTP_ONLY=1 node --experimental-strip-types --no-warnings server.ts --http-only
```
