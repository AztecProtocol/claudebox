# ClaudeBox

Run Claude agents in isolated Docker containers. Trigger from Slack, HTTP, or the CLI.

## Quick Start

```bash
npm install

# Local server (HTTP only, no Slack)
CLAUDEBOX_SESSION_PASS=secret node --experimental-strip-types server.ts --http-only

# CLI
node cli.ts run --server http://localhost:3000 "fix the flaky test"
node cli.ts sessions
node cli.ts guide <worktree-id>
```

## Architecture

```
Slack / HTTP API / CLI  ──▶  server.ts  ──▶  Docker container (Claude + MCP sidecar)
                                │
                           SessionStore, PluginRuntime, Slack handlers
```

- **libclaudebox** — Generic framework: Docker orchestration, sessions, MCP tools, Slack, HTTP dashboard.
- **Profiles** — Self-contained packages in `profiles/`: MCP sidecar, plugin config, CLAUDE.md prompt.

## Profiles

```
profiles/my-profile/
  plugin.ts            # Docker config, channels, routes, schemas
  mcp-sidecar.ts       # MCP tools (runs inside container)
  container-claude.md  # System prompt
```

Profiles can override Docker image, env vars, bind mounts via `DockerConfig`:

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
claudebox run [--profile <name>] <prompt>       Start a session
claudebox resume [<worktree-id>] <prompt>        Resume a session
claudebox sessions [--user <name>]               List sessions
claudebox logs <worktree-id> [--follow]          View activity
claudebox pull <worktree-id>                     Download session locally
claudebox push <worktree-id>                     Upload changes back
claudebox guide <worktree-id>                    Review session interactively
claudebox status                                 Server health
claudebox profiles                               List profiles
claudebox config <key> [value]                   Get/set config
```

## HTTP API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/run` | Bearer | Start session |
| `GET` | `/session/<id>` | Bearer | Session JSON |
| `GET` | `/s/<id>` | Public | Status page |
| `POST` | `/s/<id>/resume` | Basic | Resume session |
| `POST` | `/s/<id>/cancel` | Basic | Cancel session |
| `GET` | `/dashboard` | Public | Dashboard |
| `GET` | `/health` | None | Health check |

## Session Model

Sessions live in worktrees. Each run resumes prior context automatically.

```
~/.claudebox/worktrees/<16-hex-id>/
  workspace/           # Git checkout
  claude-projects/     # Session JSONL
  activity.jsonl       # Activity log
  meta.json            # Metadata
```

## Deployment

```bash
# Systemd service
./scripts/setup-systemd.sh
systemctl --user restart claudebox

# Or run directly
CLAUDEBOX_SESSION_PASS=secret CLAUDEBOX_API_SECRET=token \
  node --experimental-strip-types server.ts --http-only
```

| Change | Action |
|--------|--------|
| Profile MCP sidecar | Immediate (bind-mounted) |
| Profile plugin.ts | Server restart |
| server.ts / libclaudebox | Server restart |
| Docker image | `docker pull` / rebuild |

## User Settings

`~/.claude/claudebox/settings.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `image` | `devbox:latest` | Docker image |
| `defaultProfile` | `default` | Default profile |
| `profileDirs` | `[]` | Extra profile directories |
| `server` | — | Server URL for CLI |
| `token` | — | API token for server |
