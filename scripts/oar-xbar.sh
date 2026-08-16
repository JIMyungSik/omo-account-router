#!/usr/bin/env bash
# SwiftBar / xbar plugin wrapper.
# Install:
#   mkdir -p ~/Library/Application\ Support/SwiftBar
#   ln -sf /absolute/path/to/omo-account-router/scripts/oar-xbar.sh \
#     ~/Library/Application\ Support/SwiftBar/oar.5s.sh
# Or for xbar:
#   ln -sf ... ~/Library/Application\ Support/xbar/plugins/oar.5s.sh
set -euo pipefail
OAR_BIN="${OAR_BIN:-$HOME/.local/bin/oar}"
if [ ! -x "$OAR_BIN" ]; then
  echo "OAR?"
  echo "---"
  echo "oar not found at $OAR_BIN"
  exit 0
fi
exec "$OAR_BIN" panel --xbar --hours "${OAR_PANEL_HOURS:-24}"
