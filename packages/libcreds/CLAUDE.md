# libcreds Security Model

## Danger Levels

Every credentialed operation is tagged with exactly one danger level:
- **read** — GET, list, fetch (no side effects)
- **write** — POST, PUT, PATCH (creates or updates resources)
- **destructive** — deletes, force-pushes, closes PRs/issues

There is no **admin** level. No operation grants org-level or account-level permissions.

## Session Context

Each `Creds` instance carries an immutable `SessionContext` that captures:
- Who triggered the session (Slack user)
- Where it was triggered (Slack channel/thread, GitHub issue/PR)
- Which profile is active
- Runtime mode (host vs sidecar)

Session context cannot be modified after creation. All policy checks and audit entries reference it.

## Profile Grants

Each profile declares a `ProfileGrant` specifying:
- **Repo whitelist** — which GitHub repos it can access (read-only repos separate)
- **Operation whitelist** — which operations are allowed per service
- **Extra channels** — Slack channels beyond the session thread
- **Team keys** — Linear teams allowed for write operations

Unknown profiles fall back to `MINIMAL_GRANT` (read-only GitHub, session-scoped Slack, no Linear).

## Audit Logging

All credential operations are logged to session JSONL files:
- Logged: timestamp, service, operation, danger level, sanitized detail, allowed/denied, session ID
- **Never logged**: tokens, secrets, credentials, request/response bodies

Blocked operations also print to stderr for container log visibility.

## Bot Credential Tier

The `BotClient` provides container-side bot operations (update comments, DM authors, set reactions).
All bot operations are **always proxied through the host server** via `POST /api/internal/creds`.
Containers never hold raw tokens for bot-level operations.

## Token Isolation

Only `libcreds` (container-side) and `libcreds-host` (server-side) touch token environment variables.
No other code should read `GH_TOKEN`, `SLACK_BOT_TOKEN`, or `LINEAR_API_KEY` directly.

## Explicitly Out of Scope

- Anthropic API keys / Claude Code subscription management
- Redis/SSH credential proxying
- Credential rotation / expiry management
- Rate limiting for external APIs
