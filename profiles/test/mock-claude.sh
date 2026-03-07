#!/usr/bin/env bash
# mock-claude.sh — Replaces the real claude binary for e2e testing.
#
# Parses claude's CLI flags, calls MCP tools via JSON-RPC on the sidecar,
# and writes activity.jsonl. Exercises the full session lifecycle.
#
# Usage (called by container-entrypoint.sh):
#   CLAUDE_BINARY=/opt/claudebox/profiles/test/mock-claude.sh
#   container-entrypoint.sh calls: $CLAUDE_BIN --print -p "prompt" --session-id UUID

set -euo pipefail

# ── Parse claude CLI flags ───────────────────────────────────────
PROMPT=""
SESSION_ID=""
MODEL=""
RESUME_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p)           PROMPT="$2"; shift 2 ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --model)      MODEL="$2"; shift 2 ;;
    --resume)     RESUME_ID="$2"; shift 2 ;;
    --print|--dangerously-skip-permissions|--fork-session) shift ;;
    --mcp-config) shift 2 ;;  # skip config path
    *)            shift ;;
  esac
done

SIDECAR_URL="${CLAUDEBOX_SIDECAR_HOST:-localhost}:${CLAUDEBOX_SIDECAR_PORT:-9801}"
ACTIVITY_FILE="/workspace/activity.jsonl"
MCP_ID=1

echo "[mock-claude] Session: ${SESSION_ID:-unknown}"
echo "[mock-claude] Prompt: ${PROMPT:0:100}"
echo "[mock-claude] Sidecar: $SIDECAR_URL"
[ -n "$RESUME_ID" ] && echo "[mock-claude] Resume: $RESUME_ID"
[ -n "$MODEL" ] && echo "[mock-claude] Model: $MODEL"

# ── Helpers ──────────────────────────────────────────────────────

log_activity() {
  local type="$1" text="$2"
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",\"type\":\"$type\",\"text\":\"$text\"}" >> "$ACTIVITY_FILE"
}

# Call an MCP tool via JSON-RPC. The sidecar returns SSE format:
#   event: message\ndata: {"result":...}
# We extract the JSON from the `data:` line.
mcp_call() {
  local tool="$1" args="$2"
  local id=$MCP_ID
  MCP_ID=$((MCP_ID + 1))

  local payload="{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"

  echo "[mock-claude] MCP call: $tool"
  local raw_response
  raw_response=$(curl -s --max-time 30 -X POST "http://$SIDECAR_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$payload" 2>&1) || {
    echo "[mock-claude] MCP call failed: $tool (curl error)"
    log_activity "error" "MCP call failed: $tool"
    return 1
  }

  # Extract JSON from SSE `data:` line
  local response
  response=$(echo "$raw_response" | grep '^data: ' | head -1 | sed 's/^data: //')
  if [ -z "$response" ]; then
    # Maybe it's plain JSON (not SSE)
    response="$raw_response"
  fi

  echo "[mock-claude] MCP response ($tool): ${response:0:200}"
  log_activity "tool" "Called $tool"
}

# ── Session lifecycle ────────────────────────────────────────────

log_activity "status" "mock-claude starting"

# 1. Get session context
echo ""
echo "━━━ Step 1: get_context ━━━"
mcp_call "get_context" '{}' || true

# 2. Set workspace name
echo ""
echo "━━━ Step 2: set_workspace_name ━━━"
mcp_call "set_workspace_name" '{"name":"test-session"}' || true

# 3. Clone the repo
echo ""
echo "━━━ Step 3: clone_repo ━━━"
CLONE_REF="${CLAUDEBOX_BASE_BRANCH:-main}"
mcp_call "clone_repo" "{\"ref\":\"origin/$CLONE_REF\"}" || true

# 4. Check session status
echo ""
echo "━━━ Step 4: session_status ━━━"
mcp_call "session_status" '{"status":"Running e2e test"}' || true

# 5. Verify workspace has repo
echo ""
echo "━━━ Step 5: workspace check ━━━"
echo "[mock-claude] cwd: $(pwd)"
if [ -d "/workspace/test-mfh" ]; then
  echo "[mock-claude] repo cloned: $(ls /workspace/test-mfh/ | head -10)"
  log_activity "status" "Repo cloned successfully"
else
  echo "[mock-claude] repo dir not found at /workspace/test-mfh"
  log_activity "warning" "Repo dir not found"
fi

# 6. Record a stat (if schema available)
echo ""
echo "━━━ Step 6: record_stat ━━━"
mcp_call "record_stat" '{"schema":"test_metric","data":{"result":"pass","duration_ms":42}}' || true

# 7. Respond to user
echo ""
echo "━━━ Step 7: respond_to_user ━━━"
mcp_call "respond_to_user" '{"message":"Mock session completed successfully. All MCP tools exercised."}' || true

log_activity "status" "mock-claude completed"

echo ""
echo "[mock-claude] Done (exit 0)"
exit 0
