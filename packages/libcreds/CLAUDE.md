# libcreds

Typed, audit-logged API clients for GitHub, Slack, and Linear.

## Design

Simple wrappers around external APIs. Each method logs an audit entry, then makes the call.
No grant checking, no policy engine — security boundary is the token itself.

## Session Context

Each `Creds` instance carries a `SessionContext` with profile, runtime mode, and Slack coordinates.

## Audit Logging

All operations are logged to session JSONL files:
- Logged: timestamp, service, access level, detail, profile, session ID
- **Never logged**: tokens, secrets, credentials

## Token Isolation

Only `libcreds` (container-side) and `libcreds-host` (server-side) read token env vars.
No other code should access `GH_TOKEN`, `SLACK_BOT_TOKEN`, or `LINEAR_API_KEY` directly.

## Trust Model

- **Host mode**: clients call APIs directly with raw tokens
- **Sidecar mode**: Slack proxies through host's `/api/internal/slack`
