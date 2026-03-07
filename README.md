# ClaudeBox

Run Claude agents in isolated Docker containers. Trigger from Slack, HTTP, or the CLI.
Each agent gets its own git worktree, MCP tools, and can create PRs, post to Slack, and run CI.

## Quick Start

```bash
npm install

# Local server (HTTP only, no Slack)
CLAUDEBOX_SESSION_PASS=secret node --experimental-strip-types server.ts --http-only

# CLI
node cli.ts run --server http://localhost:3000 "fix the flaky test"
node cli.ts sessions
node cli.ts guide <worktree-id>    # review a session, ask questions, push back
```

## Architecture

```
Slack (Socket Mode)  ─┐
                       ├─▶  server.ts  ─▶  Docker container (Claude)
HTTP API (/run)       ─┘       │                  │
CLI (cli.ts)          ─┘       │            MCP sidecar
                          Session store      (GitHub, Slack, gist)
                          Plugin system
```

### Three Layers

1. **libclaudebox** — Generic framework: Docker sandbox orchestration, session management,
   MCP tool framework, Slack bot, HTTP dashboard. Zero org-specific code.
2. **Plugin system** — `Plugin` interface, `PluginContext`, `PluginRuntime`. Plugins compose
   on top of shared infrastructure (Docker, SessionStore, Slack).
3. **Profiles** — Self-contained packages: MCP sidecar, plugin routes, CLAUDE.md prompt.
   Repo ships defaults; users add their own.

### No Custom Docker Image Required

ClaudeBox uses `devbox:latest` by default. The container needs: `node`, `bash`, `git`.
The `claude` binary and all code is bind-mounted from the host at runtime — nothing is baked
into the image. Override with `CLAUDEBOX_DOCKER_IMAGE` env var or user settings.

Profiles can override the image (e.g. `image: "my-org/devbox:latest"` in DockerConfig).
Or set globally via `CLAUDEBOX_DOCKER_IMAGE` env var or user settings.

## Profiles

A profile is a directory with some combination of:

```
my-profile/
  plugin.ts            # Docker config, channels, routes, schemas (optional)
  mcp-sidecar.ts       # MCP tools (runs inside container)
  container-claude.md  # System prompt for Claude (optional)
```

### Creating a Profile

Profiles live in `profiles/` in the repo.

**Example: Adding Notion MCP access**

Create `profiles/with-notion/plugin.ts`:

```typescript
import type { Plugin } from "../../packages/libclaudebox/plugin.ts";

const plugin: Plugin = {
  name: "with-notion",
  docker: {
    extraEnv: ["NOTION_TOKEN"],  // pass through from host env
  },
  requiredCredentials: ["NOTION_TOKEN"],
  setup() {},
};

export default plugin;
```

Create `profiles/with-notion/mcp-sidecar.ts`:

```typescript
#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import {
  registerCommonTools, startMcpHttpServer,
} from "../../packages/libclaudebox/mcp/base.ts";

function createServer() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "with-notion", version: "1.0.0" });

  registerCommonTools(server, { tools: "respond_to_user, session_status, github_api" });

  server.tool("notion_search", "Search Notion pages", { query: z.string() }, async ({ query }) => {
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data.results, null, 2) }] };
  });

  return server;
}

startMcpHttpServer(createServer);
```

Run with: `claudebox run --profile with-notion "summarize my Notion workspace"`

### Profile Docker Config

Profiles can customize their container environment via `DockerConfig`:

```typescript
interface DockerConfig {
  image?: string;              // Override base image (e.g. "python:3.12")
  mountReferenceRepo?: boolean; // Mount local .git for fast clones (default: true)
  extraBinds?: string[];       // Extra bind mounts
  extraEnv?: string[];         // Extra env vars passed to container
}
```

## User Settings

`~/.claude/claudebox/settings.json`:

```json
{
  "image": "devbox:latest",
  "defaultProfile": "default",
  "profileDirs": ["/home/me/my-profiles"],
  "containerUser": "claude",
  "server": "https://claudebox.work",
  "token": "abc123"
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `image` | `devbox:latest` | Docker image for containers |
| `defaultProfile` | `default` | Profile used when none specified |
| `profileDirs` | `[]` | Extra directories to scan for profiles |
| `containerUser` | `claude` | User inside containers |
| `server` | — | Server URL for CLI commands |
| `token` | — | API token for server |

## CLI

```
claudebox run [--profile <name>] [--model <m>] <prompt>     Start a session
claudebox resume [<worktree-id>] <prompt>                   Resume a session
claudebox sessions [--user <name>] [--profile <name>]       List sessions
claudebox logs <worktree-id> [--follow]                     View activity
claudebox pull <worktree-id>                                Download session locally
claudebox push <worktree-id> [--resume <prompt>]            Upload local changes back
claudebox guide <worktree-id>                               Review session & ask questions
claudebox status                                            Server health
claudebox profiles                                          List available profiles
claudebox config <key> [value]                              Get/set config
```

### Guide Flow

`claudebox guide` pulls a remote session, runs Claude locally to review the conversation
and ask you guiding questions, then pushes the updated session back:

```bash
claudebox guide d9441073aae158ae
# Claude reviews the session history and asks:
#   1. Should we focus on critical bugs or code style?
#   2. Single PR or multiple?
# Your answers become part of the session context.

claudebox guide d9441073aae158ae --resume "focus on critical bugs, single PR"
# Pushes your answers back and resumes on the server
```

## HTTP API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/run` | Bearer | Start a session |
| `GET` | `/session/<id>` | Bearer | Session status (JSON) |
| `GET` | `/session/<id>/bundle` | Bearer | Download session JSONL (tar) |
| `POST` | `/session/<id>/bundle` | Bearer | Upload session JSONL (tar) |
| `GET` | `/s/<id>` | Public | Status page (HTML) |
| `POST` | `/s/<id>/resume` | Basic | Resume session |
| `POST` | `/s/<id>/cancel` | Basic | Cancel session |
| `DELETE` | `/s/<id>` | Basic | Delete worktree |
| `GET` | `/dashboard` | Public | Workspace dashboard |
| `GET` | `/health` | None | Health check |

## Session Model

Sessions live in **worktrees**. A worktree persists across runs:

```
~/.claudebox/worktrees/<16-hex-id>/
  workspace/              # Git checkout + files
  claude-projects/        # Claude session JSONL files
  activity.jsonl          # Activity log
  meta.json               # Worktree metadata
```

**IDs:**
- `d9441073aae158ae` — Worktree ID (stable, 16 hex chars)
- `d9441073aae158ae-3` — Session log ID (per run)

**Resume:** Each run automatically resumes the previous session's context via Claude's
`--resume` flag. The agent retains memory of prior work in the same worktree.

## Deployment

### Local HTTP-only Server

Run without Slack for local development or SSH-tunneled access:

```bash
CLAUDEBOX_SESSION_PASS=secret \
CLAUDEBOX_API_SECRET=mytoken \
  node --experimental-strip-types server.ts --http-only
```

This starts just the HTTP server (no Slack Socket Mode). Protect access via SSH tunnel:

```bash
# On your machine:
ssh -L 3000:localhost:3000 your-server
# Then: claudebox config server http://localhost:3000
```

### Full Server (Slack + HTTP)

Requires `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, plus other env vars. See `packages/libclaudebox/config.ts`.

```bash
systemctl --user restart claudebox-slack
```

### What Goes Where

| Change | Action |
|--------|--------|
| Profile MCP sidecar | Immediate (bind-mounted) |
| Profile plugin.ts | Server restart |
| libclaudebox code | Server restart |
| server.ts | Server restart |
| Docker image | `docker pull` / rebuild |

## Development

```bash
npm install
npm test                  # Run all tests (218 tests)

# Test a profile
node cli.ts profiles      # List available profiles

# Run with mock claude
MOCK_DELAY_MS=10 node tests/mocks/mock-claude.ts -p "hello"
```
