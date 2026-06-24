#!/usr/bin/env bash
# Restart the claude5 session. Run by max-gateway on an authorized /sys restart.
# Detaches so it survives killing the very session it is restarting. The daemon
# (separate systemd process) keeps running and buffers inbound to inbox/ during
# the gap; the fresh bridge drains the backlog on reconnect.
set -uo pipefail
TMUX_SESSION="${CLAUDE5_TMUX:-claude5}"
START="${CLAUDE5_START:-$HOME/.local/bin/claude5-start}"

setsid nohup bash -c "
  unset TMUX
  tmux has-session -t '$TMUX_SESSION' 2>/dev/null && tmux kill-session -t '$TMUX_SESSION' || true
  sleep 2
  tmux new-session -d -s '$TMUX_SESSION' '$START'
" </dev/null >/dev/null 2>&1 &
echo "restart scheduled for session '$TMUX_SESSION'"
