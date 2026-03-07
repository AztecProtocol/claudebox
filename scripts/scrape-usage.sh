#!/usr/bin/env bash
# scrape-usage.sh — Get Claude /usage output by faking a TTY via tmux.
#
# Usage: ./scripts/scrape-usage.sh
# Output: Raw /usage output to stdout

set -euo pipefail

S="claude-usage-$$"
trap 'tmux kill-session -t "$S" 2>/dev/null || true' EXIT

# Launch claude in a detached tmux with a wide pane
tmux new-session -d -s "$S" -x 200 -y 50 "CLAUDECODE= exec claude /usage"
sleep 10
# Capture output
tmux capture-pane -t "$S" -p -S -200 
#2>/dev/null | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\r//g'

# Kill
tmux send-keys -t "$S" '/exit' Enter
