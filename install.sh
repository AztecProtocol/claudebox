#!/usr/bin/env bash
# Install ClaudeBox.
#
# Usage:
#   git clone <repo> ~/.claude/claudebox/repo
#   cd ~/.claude/claudebox/repo
#   ./install.sh
#
# What this does:
#   1. Runs bootstrap.sh (npm install)
#   2. Creates data directories
#   3. Symlinks bin/claudebox → ~/.local/bin/claudebox
#   4. Optionally sets up systemd user service
#
# After install:
#   claudebox                  # start server (auto-updates from origin/next)
#   claudebox --http-only      # no Slack
#   claudebox --no-auto-update # disable git pull loop

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.claudebox"
ENV_FILE="$DATA_DIR/env"

echo "ClaudeBox installer"
echo "  Repo:  $REPO_DIR"
echo ""

# 1. Bootstrap
echo "[1/4] Installing dependencies..."
"$REPO_DIR/bootstrap.sh"

# 2. Create data directories
echo "[2/4] Creating data directories..."
mkdir -p "$DATA_DIR/sessions" "$DATA_DIR/worktrees" "$DATA_DIR/stats"

# 3. Symlink bin
echo "[3/4] Linking claudebox to $BIN_DIR..."
mkdir -p "$BIN_DIR"
ln -sf "$REPO_DIR/bin/claudebox" "$BIN_DIR/claudebox"

# Check PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  echo ""
  echo "  ⚠ $BIN_DIR is not in your PATH. Add to your shell profile:"
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
fi

# 4. Env file
if [ ! -f "$ENV_FILE" ]; then
  echo "[4/4] Creating env file..."
  cat > "$ENV_FILE" << 'EOF'
# ClaudeBox environment — sourced by systemd service.
# Required:
CLAUDEBOX_SESSION_PASS=
CLAUDEBOX_API_SECRET=
GH_TOKEN=

# Slack (not needed with --http-only):
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=

# Optional:
# CLAUDEBOX_PORT=3000
# CLAUDEBOX_HOST=claudebox.work
# CLAUDEBOX_DOCKER_IMAGE=devbox:latest
EOF
  chmod 600 "$ENV_FILE"
  echo "  Created $ENV_FILE — edit and fill in secrets."
else
  echo "[4/4] Env file exists: $ENV_FILE"
fi

echo ""
echo "Done! Run:"
echo "  claudebox              # start server"
echo "  claudebox --http-only  # without Slack"
echo ""
echo "Optional systemd setup:"
echo "  ./scripts/setup-systemd.sh"
