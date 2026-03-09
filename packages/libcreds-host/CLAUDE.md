# libcreds-host

Server-side privileged credential operations for ClaudeBox.

## Privilege Level

This package is **MORE PRIVILEGED** than `libcreds` sidecar usage:
- Has direct access to raw `SLACK_BOT_TOKEN` and `GH_TOKEN` via `createHostCreds()`
- Can access **any** Slack channel and **any** repo in the org (not session-scoped)
- Uses the `_host` profile grant from `libcreds/grants.ts`

## Usage

Only used by **host-side code** — `server.ts` and `http-routes.ts`. Never imported from container/sidecar code.

## Structure

- `index.ts` — `getHostCreds()` singleton factory, re-exports submodules
- `slack.ts` — `HostSlack` static class: setReaction, updateMessage, postMessage, getChannelInfo, listUsers, openConversation, dmAuthor
- `github.ts` — `HostGitHub` static class: updateIssueComment, listIssues, getIssue, getPull, addIssueComment
- `creds-endpoint.ts` — `handleCredsEndpoint()`: unified POST /api/internal/creds handler that routes sidecar proxy requests to the correct Slack/GitHub operation

## Relationship to libcreds

- Imports `createHostCreds` from `libcreds` (which uses `_host` profile + `HOST_GRANT`)
- All operations go through libcreds policy checking and audit logging
- **Token isolation**: `libcreds` + `libcreds-host` are the ONLY packages that read token env vars (`SLACK_BOT_TOKEN`, `GH_TOKEN`, `LINEAR_API_KEY`)

## Key Design Decisions

- Static class methods (no instantiation needed — host context is implicit)
- Channel info caching in `HostSlack` (process-lifetime cache, no TTL)
- `dmAuthor` contains full DM-on-completion logic (user lookup, DM open, message send)
- `handleCredsEndpoint` replaces the raw `/api/internal/slack` handler with typed operations
