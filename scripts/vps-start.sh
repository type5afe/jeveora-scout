#!/usr/bin/env bash
# Starts Meteora Scout in a background tmux session called "scout" and restarts it if it ever stops.
#
#   Open the dashboard:     tmux attach -t scout
#   Leave it running:       Ctrl+B, then D
#   Stop it for good:       tmux kill-session -t scout
#
# To start it on every boot, add this line with `crontab -e`:
#   @reboot $HOME/meteora/scripts/vps-start.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"

if tmux has-session -t scout 2>/dev/null; then
  echo "Already running. Open it with: tmux attach -t scout"
  exit 0
fi

# Cron and new tmux sessions don't read your shell profile, so load nvm here if Node came from it.
tmux new-session -d -s scout -x 140 -y 45 "cd '$DIR'
[ -s \"\$HOME/.nvm/nvm.sh\" ] && . \"\$HOME/.nvm/nvm.sh\"
while true; do
  node src/index.ts
  echo 'Scout stopped. Restarting in 10s (press Ctrl+C now to stop for good)...'
  sleep 10
done"

echo "Started. Open it with: tmux attach -t scout   (leave it running: Ctrl+B, then D)"
