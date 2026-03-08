#!/usr/bin/env bash
# Start ClaudeBox in local dev mode (HTTP-only, no Slack).
# Login at http://localhost:3000 with admin / dev
# Create sessions from http://localhost:3000/me

set -euo pipefail
cd "$(dirname "$0")/.."

export CLAUDEBOX_SESSION_PASS="${CLAUDEBOX_SESSION_PASS:-dev}"
export CLAUDEBOX_HTTP_ONLY=1

exec node --experimental-strip-types --no-warnings server.ts --http-only "$@"
