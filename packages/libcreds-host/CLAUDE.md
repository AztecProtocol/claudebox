# libcreds-host

Server-side credential operations for ClaudeBox.

## Usage

Only used by **host-side code** — `server.ts` and `http-routes.ts`. Never imported from container/sidecar code.

## Structure

- `index.ts` — `getHostCreds()` singleton factory, `getContainerTokens()`, `getSlackBotToken()`
- `slack.ts` — `dmAuthor()`: multi-step DM-on-completion (user lookup → DM open → send)
- `creds-endpoint.ts` — `handleCredsEndpoint()`: unified POST /api/internal/creds handler

## Token isolation

`libcreds` + `libcreds-host` are the ONLY packages that read token env vars.
