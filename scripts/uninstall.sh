#!/usr/bin/env bash
# Reverse of scripts/install.sh: stop + unload the LaunchAgent, remove the
# plist and the ~/.local/bin/oar symlink. Does NOT touch ~/.oar (vault/state)
# or ~/.omo/agent/auth.json — pass --purge-state to also delete ~/.oar.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:-$(cd ~ && pwd)}"
LOCAL_BIN="$HOME_DIR/.local/bin"
LAUNCH_AGENTS_DIR="$HOME_DIR/Library/LaunchAgents"
PLIST_LABEL="com.victor.oar-daemon"
PLIST_TARGET="$LAUNCH_AGENTS_DIR/$PLIST_LABEL.plist"

PURGE_STATE=0
for arg in "$@"; do
  case "$arg" in
    --purge-state) PURGE_STATE=1 ;;
  esac
done

echo "==> unload LaunchAgent"
if [ -f "$PLIST_TARGET" ]; then
  launchctl unload "$PLIST_TARGET" >/dev/null 2>&1 || true
  rm -f "$PLIST_TARGET"
  echo "    removed $PLIST_TARGET"
else
  echo "    not installed"
fi

echo "==> remove $LOCAL_BIN/oar symlink"
if [ -L "$LOCAL_BIN/oar" ]; then
  rm -f "$LOCAL_BIN/oar"
  echo "    removed"
else
  echo "    not present"
fi

echo "==> remove Senpi extension symlink"
EXT_LINK="$HOME_DIR/.omo/agent/extensions/oar.js"
if [ -L "$EXT_LINK" ]; then
  rm -f "$EXT_LINK"
  echo "    removed $EXT_LINK"
else
  echo "    not present"
fi

if [ "$PURGE_STATE" -eq 1 ]; then
  echo "==> purge state (~/.oar) — vault credentials will be deleted"
  rm -rf "$HOME_DIR/.oar"
  echo "    removed $HOME_DIR/.oar"
else
  echo "==> keeping $HOME_DIR/.oar (pass --purge-state to remove vault/state)"
fi

echo "==> done"
