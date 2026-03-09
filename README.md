# ClaudeBox

Run Claude in isolated Docker containers. Trigger from Slack, HTTP, or CLI.

## Design

Containers are stateless workers. The host server owns all context — which Slack thread triggered a session, what PRs it touched, where to post updates. Containers talk back through a single HTTP API (`ServerClient → host:3002`). They don't know they're in Slack.

Customization lives in **profiles** — a directory with a plugin config, MCP sidecar, and system prompt. The framework handles Docker, sessions, and routing.

Sessions persist as **git worktrees**. Resume is automatic: same Slack thread or same worktree ID picks up where it left off.

All code is **bind-mounted** into containers at runtime. No image rebuild to iterate.

## Quick Start

```bash
npm install
CLAUDEBOX_SESSION_PASS=secret node --experimental-strip-types server.ts --http-only

node cli.ts run --server http://localhost:3000 "fix the flaky test"
node cli.ts sessions
```

## Layout

```
packages/libclaudebox/     # Framework: Docker, sessions, MCP, Slack, HTTP
profiles/                  # Profiles: plugin.ts + mcp-sidecar.ts + CLAUDE.md
server.ts                  # Entry point
cli.ts                     # CLI client
```

Two HTTP servers:
- Public `:3000` — dashboard, status pages, session API
- Internal `:3002` (localhost) — sidecar→host boundary

## Profiles

```
profiles/my-profile/
  plugin.ts            # Docker config, channels, routes, credentials
  mcp-sidecar.ts       # MCP tools (runs inside container)
  container-claude.md  # System prompt
```

```typescript
const plugin: Plugin = {
  name: "my-profile",
  docker: { image: "my-image:latest", extraEnv: ["MY_TOKEN"] },
  setup() {},
};
export default plugin;
```

## CLI

```
run [--profile <name>] <prompt>    Start a session
sessions [--user <name>]           List sessions
cancel <id>                        Cancel session
status                             Server health
profiles                           List profiles
config <key> [value]               Get/set config
```

## HTTP API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/run` | Bearer | Start/resume session |
| `GET` | `/session/<id>` | Bearer | Session JSON |
| `GET` | `/s/<id>` | Public | Status page |
| `POST` | `/s/<id>/cancel` | Basic | Cancel |
| `DELETE` | `/s/<id>` | Basic | Delete worktree |
| `GET` | `/dashboard` | Public | Dashboard |
| `GET` | `/health` | None | Health check |

## Sessions

```
~/.claudebox/worktrees/<16-hex-id>/
  workspace/           # Git checkout (GC'd by disk budget)
  claude-projects/     # Session JSONL (kept forever)
  activity.jsonl       # Activity log
  meta.json            # Metadata
```

## Deployment

```bash
./scripts/setup-systemd.sh
systemctl --user restart claudebox
```

| Change | Reload |
|--------|--------|
| MCP sidecar | Immediate |
| plugin.ts / server.ts | Restart |
| Docker image | Rebuild |
