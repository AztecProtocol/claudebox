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
PROMPT_FILE="/workspace/prompt.txt"
CLAUDE_MD_TEMPLATE="${CLAUDEBOX_CONTAINER_CLAUDE_MD:-/opt/claudebox/container-claude.md}"

echo "━━━ Container Bootstrap ━━━"
echo "MCP:     $MCP_URL"
echo "Session: $SESSION_UUID"
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

# ── Step 2: Install CLAUDE.md ────────────────────────────────────
# Placed at /workspace/.claude/CLAUDE.md — Claude will start in /workspace
# and the repo (once cloned) lives at /workspace/aztec-packages
if [ -f "$CLAUDE_MD_TEMPLATE" ]; then
    mkdir -p /workspace/.claude
    cp "$CLAUDE_MD_TEMPLATE" /workspace/.claude/CLAUDE.md
fi

# ── Step 3: Read prompt ──────────────────────────────────────────
if [ ! -f "$PROMPT_FILE" ]; then
    echo "ERROR: $PROMPT_FILE not found" >&2
    exit 1
fi
PROMPT=$(cat "$PROMPT_FILE")

# ── Step 3b: Pre-clone repo from reference if available ──────────
REPO_NAME="${CLAUDEBOX_REPO_NAME:-}"
BASE_BRANCH="${CLAUDEBOX_BASE_BRANCH:-next}"
REPO_DIR="/workspace/${REPO_NAME}"

if [ -n "$REPO_NAME" ] && [ -d "/reference-repo/.git" ] && [ ! -d "${REPO_DIR}/.git" ]; then
    echo ""
    echo "━━━ Pre-cloning $REPO_NAME (sparse) from reference ━━━"
    git config --global --add safe.directory /reference-repo/.git
    git config --global --add safe.directory "$REPO_DIR"
    # Sparse clone: only checkout .claude/ dirs (skills, settings, CLAUDE.md)
    # Claude will populate the full tree via clone_repo when it needs to work
    git clone --shared --no-checkout /reference-repo/.git "$REPO_DIR" 2>&1 || true
    if [ -d "${REPO_DIR}/.git" ]; then
        cd "$REPO_DIR"
        # Autodetect .claude-related paths from the reference repo
        CLAUDE_PATHS=$(git ls-tree -r -d --name-only HEAD 2>/dev/null | grep -E '(^\.claude$|/\.claude$)' || true)
        if [ -n "$CLAUDE_PATHS" ]; then
            git sparse-checkout set --cone $CLAUDE_PATHS 2>/dev/null || true
        else
            git sparse-checkout set --cone .claude 2>/dev/null || true
        fi
        # Try to checkout the base branch
        git checkout --detach "origin/${BASE_BRANCH}" 2>/dev/null \
            || git checkout --detach origin/main 2>/dev/null \
            || git checkout --detach HEAD 2>/dev/null \
            || true
        echo "Pre-cloned (sparse) at $(git rev-parse --short HEAD 2>/dev/null || echo '???')"
    fi
elif [ -n "$REPO_NAME" ] && [ -d "${REPO_DIR}/.git" ]; then
    echo "Repo already exists at $REPO_DIR"
    cd "$REPO_DIR"
fi

# Set working directory: prefer repo dir if it exists, else /workspace
WORK_DIR="$REPO_DIR"
[ ! -d "$WORK_DIR" ] && WORK_DIR="/workspace"

echo ""
echo "━━━ Launching Claude ━━━"
echo ""

cd "$WORK_DIR"

# ── Step 4: Run Claude (or CLAUDE_BINARY override) ────────────────
CLAUDE_BIN="${CLAUDE_BINARY:-claude}"
COMMON_ARGS=(--print --dangerously-skip-permissions --mcp-config /tmp/mcp.json -p "$PROMPT")
[ -n "$MODEL" ] && COMMON_ARGS+=(--model "$MODEL")

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
