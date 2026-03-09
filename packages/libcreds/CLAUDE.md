# libcreds Security Model

## Grant-Based Access Control

Each profile declares a `ProfileGrant` specifying what resources it can access.
Grants are checked inline in each client method — no separate policy engine.

### GitHub Grants
- **repos** — full (read + write) access
- **readOnlyRepos** — read-only access (writes blocked)
- **canClose** — allow closing issues/PRs (destructive)
- **canForcePush** — allow force-pushing (destructive)

### Slack Grants
- **extraChannels** — channels beyond the session channel
- Session channel is always allowed for write operations
- Read operations (users.list, conversations.info) are not channel-scoped

### Linear Grants
- **canWrite** — allow creating issues (default: read-only)
- **allowedTeams** — teams allowed for write operations

## Session Context

Each `Creds` instance carries a `SessionContext`. Fields marked `[POLICY]` drive access decisions:
- **profile** — determines which grant applies
- **runtime** — host (raw tokens) vs sidecar (proxied)
- **slackChannel** — Slack channel scoping for write operations

## Audit Logging

All credential operations are logged to session JSONL files:
- Logged: timestamp, service, access level, detail, allowed/denied, profile, session ID
- **Never logged**: tokens, secrets, credentials
- Blocked operations also print to stderr for container log visibility

## Token Isolation

Only `libcreds` (container-side) and `libcreds-host` (server-side) read token env vars.
No other code should access `GH_TOKEN`, `SLACK_BOT_TOKEN`, or `LINEAR_API_KEY` directly.

## Trust Model

- **Host mode**: clients call APIs directly with raw tokens
- **Sidecar mode**: Slack proxies through host's `/api/internal/slack`; grant checking happens in the sidecar before proxying
