# ClaudeBox

Run Claude agents in isolated Docker containers. Trigger from Slack, HTTP, or CLI.

## Philosophy

**The host is the brain; containers are hands.** The server owns all external context — Slack threads, GitHub PRs, session history. Containers run Claude with MCP tools but know nothing about where they were triggered from. They talk to the host through a typed HTTP boundary (`ServerClient`), and the host decides what to do with the results.

**Profiles are the unit of customization.** A profile is a directory with a plugin config, an MCP sidecar, and a system prompt. It controls what Docker image to use, what tools Claude gets, what channels route to it, and what credentials it needs. The framework provides orchestration; profiles provide purpose.

**Sessions persist in worktrees.** Each session gets a git worktree that survives across runs. Resume is automatic — reply in the same Slack thread or pass the same worktree ID, and Claude picks up where it left off with full transcript history.

**Nothing is baked into the image.** Claude, the MCP sidecar, and all code are bind-mounted from the host at runtime. Sidecar changes take effect immediately. No rebuild cycle for iteration.

## Quick Start

```bash
npm install

# HTTP-only server (no Slack)
CLAUDEBOX_SESSION_PASS=secret node --experimental-strip-types server.ts --http-only

# Start a session
node cli.ts run --server http://localhost:3000 "fix the flaky test"
node cli.ts sessions
```

## Architecture

```
Slack / HTTP / CLI  ──▶  server.ts  ──▶  Docker container
                              │               │
                         SessionStore     MCP sidecar ──▶ ServerClient ──▶ host
                         PluginRuntime
                         Slack handlers
```

```
packages/libclaudebox/     # Framework (Docker, sessions, MCP, Slack, HTTP)
profiles/                  # Profiles (plugin.ts + mcp-sidecar.ts + CLAUDE.md)
server.ts                  # Entry point
cli.ts                     # CLI client
```

**Two HTTP servers:**
- Public (`:3000`) — dashboard, status pages, session API, plugin routes
- Internal (`:3002`, localhost only) — sidecar→host API (Slack updates, credential proxy, comments)

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
  requiredCredentials: ["MY_TOKEN"],
  setup() {},
};
export default plugin;
```

## CLI

```
run [--profile <name>] <prompt>       Start a session
sessions [--user <name>]              List sessions
cancel <id>                           Cancel session
status                                Server health
profiles                              List profiles
config <key> [value]                  Get/set config
```

## HTTP API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/run` | Bearer | Start session (or resume with `worktree_id`) |
| `GET` | `/session/<id>` | Bearer | Session JSON |
| `GET` | `/s/<id>` | Public | Status page |
| `POST` | `/s/<id>/cancel` | Basic | Cancel session |
| `DELETE` | `/s/<id>` | Basic | Delete worktree |
| `GET` | `/dashboard` | Public | Dashboard |
| `GET` | `/health` | None | Health check |

## Session Model

```
~/.claudebox/worktrees/<16-hex-id>/
  workspace/           # Git checkout (subject to GC)
  claude-projects/     # Session JSONL (preserved)
  activity.jsonl       # Activity log
  meta.json            # Metadata
```

Resume: thread reply (Slack), `worktree_id` param (HTTP), or hash reference (`#abc123`).
GC: workspace dirs cleaned after 1 day when disk exceeds 100GB budget. Metadata and transcripts are never deleted.

## Deployment

```bash
./scripts/setup-systemd.sh
systemctl --user restart claudebox
```

| Change | Action |
|--------|--------|
| Profile MCP sidecar | Immediate (bind-mounted) |
| Profile plugin.ts / server.ts | Server restart |
| Docker image | `docker pull` / rebuild |

## Settings

`~/.claude/claudebox/settings.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `image` | `devbox:latest` | Docker image |
| `defaultProfile` | `default` | Default profile |
| `profileDirs` | `[]` | Extra profile directories |
| `server` | — | Server URL for CLI |
| `token` | — | API token |
