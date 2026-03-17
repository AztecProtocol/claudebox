#!/usr/bin/env bash
# Refresh OAuth token by briefly launching claude in a PTY
# script -c allocates a pseudo-TTY so claude thinks it's interactive

export HOME=/mnt/user-data/claude
export PATH="$HOME/.local/bin:$PATH"

script -qec "claude" /dev/null &
PID=$!
sleep 10
kill $PID 2>/dev/null
wait $PID 2>/dev/null
echo "[$(date -Is)] OAuth token refreshed (pid=$PID)"
