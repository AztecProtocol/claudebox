#!/usr/bin/env bash
# container-entrypoint.sh — Runs INSIDE the Claude container.
# Writes MCP config, installs CLAUDE.md, launches Claude.
# Repo clone is lazy — Claude calls the clone_repo MCP tool when needed.
#
# Required env:  CLAUDEBOX_MCP_URL, SESSION_UUID
# Prompt:        /workspace/prompt.txt (mounted by host)
# Optional env:  CLAUDEBOX_RESUME_ID

set -euxo pipefail
trap 'echo ""; echo "━━━ Process exited ━━━"' EXIT

# Ensure cargo/rust tools are on PATH
export PATH="$HOME/.cargo/bin:$PATH"

MCP_URL="${CLAUDEBOX_MCP_URL:?required}"
SESSION_UUID="${SESSION_UUID:?required}"
RESUME_ID="${CLAUDEBOX_RESUME_ID:-}"
MODEL="${CLAUDEBOX_MODEL:-}"
PROFILE="${CLAUDEBOX_PROFILE:-default}"
PROMPT_FILE="/workspace/prompt.txt"
PROFILE_DIR="/opt/claudebox-profile"

echo "━━━ Container Bootstrap ━━━"
echo "MCP:     $MCP_URL"
echo "Session: $SESSION_UUID"
echo "Profile: $PROFILE"
[ -n "$RESUME_ID" ] && echo "Resume:  $RESUME_ID"
[ -n "$MODEL" ] && echo "Model:   $MODEL"

# ── Step 1: MCP config ──────────────────────────────────────────
cat > /tmp/mcp.json <<EOF
{
  "mcpServers": {
    "claudebox": {
      "type": "http",
      "url": "$MCP_URL"
    }
  }
}
EOF

# ── Step 2: Write session metadata CLAUDE.md ─────────────────────
# Profile instructions live in $PROFILE_DIR/CLAUDE.md (loaded via --add-dir).
# This file just injects session-specific context into the workspace.
mkdir -p /workspace/.claude
cat > /workspace/.claude/CLAUDE.md <<METAEOF
# Session

- Profile: $PROFILE
- Session: $SESSION_UUID
- MCP: $MCP_URL
$([ -n "$RESUME_ID" ] && echo "- Resuming: $RESUME_ID")
$([ -n "$MODEL" ] && echo "- Model: $MODEL")
METAEOF

# ── Step 3: Read prompt ──────────────────────────────────────────
if [ ! -f "$PROMPT_FILE" ]; then
    echo "ERROR: $PROMPT_FILE not found" >&2
    exit 1
fi
PROMPT=$(cat "$PROMPT_FILE")

echo ""
echo "━━━ Launching Claude ━━━"
echo ""

cd /workspace

# ── Step 4: Run Claude (or CLAUDE_BINARY override) ────────────────
CLAUDE_BIN="${CLAUDE_BINARY:-claude}"
COMMON_ARGS=(--print --dangerously-skip-permissions --mcp-config /tmp/mcp.json -p "$PROMPT")
[ -n "$MODEL" ] && COMMON_ARGS+=(--model "$MODEL")
# Give Claude read/write access to the profile directory (skills, CLAUDE.md, etc.)
[ -d "$PROFILE_DIR" ] && COMMON_ARGS+=(--add-dir "$PROFILE_DIR")

set +e
if [ -n "$RESUME_ID" ]; then
    "$CLAUDE_BIN" "${COMMON_ARGS[@]}" --resume "$RESUME_ID" --fork-session
    exit_code=$?
    # Fall back to fresh session if resume fails (e.g. JSONL from old mount path)
    if [ "$exit_code" -ne 0 ]; then
        echo ""
        echo "━━━ Resume failed (exit $exit_code), starting fresh session ━━━"
        echo ""
        RESUME_ID=""
    fi
fi
if [ -z "$RESUME_ID" ]; then
    "$CLAUDE_BIN" "${COMMON_ARGS[@]}" --session-id "$SESSION_UUID"
    exit_code=$?
fi
set -e

echo ""
echo "━━━ Exit: $exit_code ━━━"
exit "$exit_code"
