# libcreds-host

Server-side privileged credential operations for ClaudeBox.

## Privilege Level

This package is **MORE PRIVILEGED** than `libcreds` sidecar usage:
- Has direct access to raw `SLACK_BOT_TOKEN` and `GH_TOKEN` via `createHostCreds()`
- Can access **any** Slack channel and **any** repo in the org (not session-scoped)
- Uses the `_host` profile grant from `libcreds/grants.ts`

## Usage

Only used by **host-side code** — `server.ts` and `http-routes.ts`. Never imported from container/sidecar code.

For simple operations, use `getHostCreds().github.*` / `getHostCreds().slack.*` directly.
Only use `dmAuthor()` from `slack.ts` — it's the only multi-step operation that warrants a helper.

## Structure

- `index.ts` — `getHostCreds()` singleton factory, `getContainerTokens()`, `getSlackBotToken()`
- `slack.ts` — `dmAuthor()`: multi-step DM-on-completion (user lookup → DM open → send)
- `creds-endpoint.ts` — `handleCredsEndpoint()`: unified POST /api/internal/creds handler

## Relationship to libcreds

- Imports `createHostCreds` from `libcreds` (which uses `_host` profile + `HOST_GRANT`)
- All operations go through libcreds policy checking and audit logging
- **Token isolation**: `libcreds` + `libcreds-host` are the ONLY packages that read token env vars
