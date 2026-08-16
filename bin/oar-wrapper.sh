#!/usr/bin/env bash
# OAR CLI wrapper — installed by scripts/install.sh as a symlink target from
# ~/.local/bin/oar. Prefers the built dist/cli.js (fast startup) and falls
# back to running the TypeScript source directly via bun if dist is missing
# (e.g. right after a fresh clone before `bun run build`).
#
# Must resolve through symlinks: when invoked as ~/.local/bin/oar → this file,
# BASH_SOURCE points at the symlink path, not the real project path.
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  LINK_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$LINK_DIR/$SOURCE" ;;
  esac
done
DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ]; then
  # LaunchAgent PATH may be minimal; try common locations
  for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      BUN_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$BUN_BIN" ]; then
  echo "oar: bun not found on PATH. Install bun: https://bun.sh" >&2
  exit 1
fi

if [ -f "$DIR/dist/cli.js" ]; then
  exec "$BUN_BIN" "$DIR/dist/cli.js" "$@"
fi

if [ -f "$DIR/src/cli.ts" ]; then
  exec "$BUN_BIN" "$DIR/src/cli.ts" "$@"
fi

echo "oar: neither dist/cli.js nor src/cli.ts found under $DIR" >&2
exit 1
