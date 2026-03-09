#!/usr/bin/env bash
# Setup claudebox as a systemd user service.
#
# Usage:
#   ./scripts/setup-systemd.sh
#
# Then:
#   systemctl --user start claudebox
#   systemctl --user enable claudebox   # start on boot
#   journalctl --user -u claudebox -f   # view logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
DATA_DIR="$HOME/.claudebox"
ENV_FILE="$DATA_DIR/env"
SERVICE_FILE="$SERVICE_DIR/claudebox.service"
BIN="$REPO_DIR/bin/claudebox"

echo "==> Setting up claudebox systemd service"
echo "    Repo: $REPO_DIR"

# Run install first (idempotent)
"$REPO_DIR/install.sh"

mkdir -p "$SERVICE_DIR"

# Create systemd service — uses bin/claudebox which handles restart loop
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=ClaudeBox — Claude Code session orchestrator
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$BIN
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=default.target
EOF

echo "==> Created service: $SERVICE_FILE"

systemctl --user daemon-reload
echo "==> Reloaded systemd"

echo ""
echo "Next steps:"
echo "  1. Edit secrets:    nano $ENV_FILE"
echo "  2. Start:           systemctl --user start claudebox"
echo "  3. Enable on boot:  systemctl --user enable claudebox"
echo "  4. Linger:          sudo loginctl enable-linger \$USER"
echo "  5. Logs:            journalctl --user -u claudebox -f"
