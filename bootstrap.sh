#!/usr/bin/env bash
# Bootstrap ClaudeBox — install dependencies.
# Called by install.sh and by auto-update after pulling new code.
set -euo pipefail

cd "$(dirname "$0")"

# Install/update npm deps (skip if node_modules is fresh)
if [ package.json -nt node_modules/.package-lock.json ] 2>/dev/null || [ ! -d node_modules ]; then
  echo "[bootstrap] npm install..."
  npm install --no-audit --no-fund --prefer-offline 2>&1 | tail -3
else
  echo "[bootstrap] Dependencies up to date."
fi
