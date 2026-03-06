# ClaudeBox

Automated Claude Code session orchestrator — Slack bot + HTTP dashboard + Docker containers.

## Architecture

- **`server.ts`** — Main server: Slack Socket Mode listener + HTTP API + WebSocket. Runs as `systemd claudebox-slack.service` on the host.
- **`mcp-sidecar.ts`** / **`mcp-base.ts`** — MCP tool server that runs inside Docker containers as a sidecar. Provides GitHub, Slack, PR, issue, and stat-recording tools to Claude sessions.
- **`lib/docker.ts`** — Docker container lifecycle (create network, run sidecar + Claude container, cleanup).
- **`lib/session-store.ts`** — Session metadata persistence, worktree management, GC.
- **`lib/http-routes.ts`** — HTTP API endpoints and SSE streaming.
- **`lib/html-templates.ts`** — All dashboard HTML (workspace pages, personal dashboard, audit dashboard). Client-side JS is embedded in template literals.
- **`lib/slack-handlers.ts`** — Slack event handlers (mentions, DMs, slash commands).
- **`lib/config.ts`** — Environment variable config. All secrets come from env vars — never hardcode them.
- **`profiles/`** — Profile-specific configs (e.g. `barretenberg-audit/` with its own sidecar and container prompt).

## Key Patterns

- **MCP sidecar changes** take effect for new sessions immediately (bind-mounted, no rebuild needed).
- **`server.ts` changes** require `systemctl --user restart claudebox-slack`.
- **Dockerfile changes** require `docker build`.
- **Template literal gotcha**: Client-side JS lives inside backtick template literals. Regex `\[` must be `\\[` to survive the template literal escaping. This has caused auth form breakage before.
- **All operations must be async** — sync `execFileSync`/`rmSync` in the main event loop blocks Slack WebSocket heartbeats and causes 502s.

## Secrets

All secrets are provided via environment variables in the systemd service file. **Never hardcode secrets in source code.**

Required env vars:
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` — Slack bot credentials
- `GH_TOKEN` — GitHub PAT for API access
- `LINEAR_API_KEY` — Linear API key
- `CI_PASSWORD` — CI log access password
- `CLAUDEBOX_API_SECRET` — API authentication secret
- `CLAUDEBOX_SESSION_PASS` — Dashboard login password

## Development

```bash
# Install dependencies
npm install

# Run locally (needs env vars set)
node --experimental-strip-types --no-warnings server.ts

# Run tests
npx playwright test
```
