# ClaudeBox

Run Claude in isolated Docker containers. Trigger from Slack, HTTP, or CLI.

## Concepts

**Worktree** — a persistent workspace. Each worktree has a git checkout, session transcripts, and metadata. Worktrees survive across runs and can be resumed. Identified by a 16-hex ID like `d9441073aae158ae`.

**Run** — one Claude execution inside a worktree. Each run gets a log ID (`d9441073aae158ae-3`), writes to the worktree's transcript, and appends to its activity log. Multiple runs share one worktree.

**Profile** — a directory in `profiles/` that configures what Claude can do. Contains a plugin config (`plugin.ts`), an MCP tool server (`mcp-sidecar.ts`), and a system prompt (`container-claude.md`). Profiles control the Docker image, available tools, Slack channel routing, and required credentials.

**Host / Container boundary** — the host server owns all external context (Slack threads, PR bindings, session history). Containers are stateless workers that talk back through a single HTTP API on an internal port. They don't know how they were triggered.

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
- Internal `:3002` (localhost) — container→host boundary

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
| `POST` | `/run` | Bearer | Start/resume run |
| `GET` | `/session/<id>` | Bearer | Session JSON |
| `GET` | `/s/<id>` | Public | Status page |
| `POST` | `/s/<id>/cancel` | Basic | Cancel |
| `DELETE` | `/s/<id>` | Basic | Delete worktree |
| `GET` | `/dashboard` | Public | Dashboard |
| `GET` | `/health` | None | Health check |

## Worktree Layout

```
~/.claudebox/worktrees/<16-hex-id>/
  workspace/           # Git checkout (GC'd by disk budget)
  claude-projects/     # Run transcripts (kept forever)
  activity.jsonl       # Activity log
  meta.json            # Worktree metadata (name, tags, resolved)
```

Resume: reply in the same Slack thread, pass `worktree_id` to `/run`, or reference by hash (`#abc123`).

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
