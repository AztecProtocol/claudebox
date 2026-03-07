#!/usr/bin/env bash
# Setup claudebox as a systemd user service.
#
# Usage:
#   ./scripts/setup-systemd.sh
#
# This creates:
#   ~/.config/systemd/user/claudebox.service
#   ~/.config/claudebox/env  (env file, you fill in secrets)
#
# Then:
#   systemctl --user start claudebox
#   systemctl --user enable claudebox   # start on boot
#   journalctl --user -u claudebox -f   # view logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/claudebox"
ENV_FILE="$ENV_DIR/env"
SERVICE_FILE="$SERVICE_DIR/claudebox.service"

echo "==> Setting up claudebox systemd user service"
echo "    Repo: $REPO_DIR"

# Create directories
mkdir -p "$SERVICE_DIR" "$ENV_DIR" "$HOME/.claudebox/stats" "$HOME/.claudebox/worktrees"

# Create env file if it doesn't exist
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'ENVEOF'
# ClaudeBox environment variables
# Fill in your secrets below.

# Required — server will not start without these
CLAUDEBOX_SESSION_PASS=
CLAUDEBOX_API_SECRET=

# Slack (required for Slack mode, not needed with --http-only)
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=

# GitHub (required for PR/issue tools)
GH_TOKEN=

# Optional
# LINEAR_API_KEY=
# CLAUDEBOX_PORT=3000
# CLAUDEBOX_HOST=claudebox.work
# CLAUDEBOX_DOCKER_IMAGE=devbox:latest
# CLAUDEBOX_DEFAULT_BRANCH=main
ENVEOF
  chmod 600 "$ENV_FILE"
  echo "==> Created env file: $ENV_FILE"
  echo "    IMPORTANT: Edit this file and fill in your secrets before starting."
else
  echo "==> Env file already exists: $ENV_FILE (not overwriting)"
fi

# Detect node binary path
NODE_BIN="$(which node 2>/dev/null || echo "/usr/local/bin/node")"

# Create systemd service file
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=ClaudeBox — Claude Code session orchestrator
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN --experimental-strip-types --no-warnings server.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Resource limits
LimitNOFILE=65536

[Install]
WantedBy=default.target
EOF

echo "==> Created service file: $SERVICE_FILE"

# Reload systemd
systemctl --user daemon-reload
echo "==> Reloaded systemd daemon"

echo ""
echo "Done! Next steps:"
echo ""
echo "  1. Edit your secrets:      nano $ENV_FILE"
echo "  2. Start the service:      systemctl --user start claudebox"
echo "  3. Enable on boot:         systemctl --user enable claudebox"
echo "  4. Enable lingering:       sudo loginctl enable-linger \$USER"
echo "  5. View logs:              journalctl --user -u claudebox -f"
echo "  6. Restart after changes:  systemctl --user restart claudebox"
echo ""
echo "For HTTP-only mode (no Slack), add to $ENV_FILE:"
echo "  CLAUDEBOX_HTTP_ONLY=1"
