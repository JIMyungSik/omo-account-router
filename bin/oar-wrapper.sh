#!/usr/bin/env bash
# OAR CLI wrapper — installed by scripts/install.sh as a symlink target from
# ~/.local/bin/oar. Prefers node + dist/cli.js (correct UTF-8) and falls back
# to bun for dist or src when node is unavailable.
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

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ]; then
  for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      BUN_BIN="$candidate"
      break
    fi
  done
fi

if [ -f "$DIR/dist/cli.js" ]; then
  if [ -n "$NODE_BIN" ]; then
    exec "$NODE_BIN" "$DIR/dist/cli.js" "$@"
  fi
  if [ -n "$BUN_BIN" ]; then
    exec "$BUN_BIN" "$DIR/dist/cli.js" "$@"
  fi
  echo "oar: node or bun required to run dist/cli.js" >&2
  exit 1
fi

if [ -f "$DIR/src/cli.ts" ]; then
  if [ -n "$BUN_BIN" ]; then
    exec "$BUN_BIN" "$DIR/src/cli.ts" "$@"
  fi
  echo "oar: bun not found on PATH. Install bun: https://bun.sh" >&2
  exit 1
fi

echo "oar: neither dist/cli.js nor src/cli.ts found under $DIR" >&2
exit 1
