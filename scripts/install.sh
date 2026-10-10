#!/usr/bin/env bash
# OAR install script.
#
# Usage:
#   scripts/install.sh [--skip-build] [--skip-launchagent] [--import-auth] [--force] [--from <auth.json>]
#   (macOS and Linux; on Windows run scripts/install.ps1)
#
# Steps:
#   1. bun install
#   2. bun run build
#   3. symlink ~/.local/bin/oar -> bin/oar-wrapper.sh
#   4. ensure ~/.omo/agent/extensions/oar.js -> extensions/oar-senpi.js symlink
#   5. autostart the daemon: LaunchAgent on macOS (com.victor.oar-daemon),
#      systemd user unit on Linux (oar-daemon.service); --skip-launchagent skips it
#   6. optionally `oar import-auth --all` from the default auth.json
#      (never overwrites existing vault profiles unless --force)
#   7. print live remaining usage (`oar usage`); `oar usage --watch` keeps it live
#
# Idempotent: safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:-$(cd ~ && pwd)}"
LOCAL_BIN="$HOME_DIR/.local/bin"
LAUNCH_AGENTS_DIR="$HOME_DIR/Library/LaunchAgents"
PLIST_LABEL="com.victor.oar-daemon"
PLIST_TEMPLATE="$ROOT/packaging/$PLIST_LABEL.plist"
PLIST_TARGET="$LAUNCH_AGENTS_DIR/$PLIST_LABEL.plist"
SYSTEMD_UNIT="oar-daemon.service"
SYSTEMD_TEMPLATE="$ROOT/packaging/$SYSTEMD_UNIT"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user"

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  *)
    echo "install.sh: unsupported OS $(uname -s). On Windows run scripts/install.ps1 from PowerShell." >&2
    exit 1
    ;;
esac

SKIP_BUILD=0
SKIP_LAUNCHAGENT=0
DO_IMPORT_AUTH=0
FORCE_IMPORT=0
FROM_AUTH_JSON="$HOME_DIR/.omo/agent/auth.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-launchagent) SKIP_LAUNCHAGENT=1 ;;
    --import-auth) DO_IMPORT_AUTH=1 ;;
    --force) FORCE_IMPORT=1 ;;
    --from) shift; FROM_AUTH_JSON="$1" ;;
    -h|--help)
      sed -n '2,19p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "install.sh: unknown flag: $1" >&2
      exit 1
      ;;
  esac
  shift
done

BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ]; then
  echo "install.sh: bun not found on PATH. Install bun first: https://bun.sh" >&2
  exit 1
fi

echo "==> OAR root: $ROOT"
echo "==> bun: $BUN_BIN"

cd "$ROOT"

echo "==> bun install"
"$BUN_BIN" install

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> bun run build"
  "$BUN_BIN" run build
fi

echo "==> link $LOCAL_BIN/oar"
mkdir -p "$LOCAL_BIN"
chmod +x "$ROOT/bin/oar-wrapper.sh"
ln -sf "$ROOT/bin/oar-wrapper.sh" "$LOCAL_BIN/oar"
case ":$PATH:" in
  *":$LOCAL_BIN:"*) ;;
  *) echo "    NOTE: $LOCAL_BIN is not on PATH. Add: export PATH=\"$LOCAL_BIN:\$PATH\"" ;;
esac

echo "==> link Senpi/OMO extensions"
EXT_DIR="$HOME_DIR/.omo/agent/extensions"
if [ -d "$HOME_DIR/.omo/agent" ]; then
  mkdir -p "$EXT_DIR"
  rm -f "$EXT_DIR/oar-senpi-client.js" "$EXT_DIR/oar-model-presets.js"
  ln -sf "$ROOT/dist/oar-extension.js" "$EXT_DIR/oar.js"
  ln -sf "$ROOT/extensions/cursor-omo.js" "$EXT_DIR/cursor-omo.js"
  ln -sf "$ROOT/extensions/oar-usage-status.js" "$EXT_DIR/oar-usage-status.js"
  echo "    linked $EXT_DIR/oar.js -> $ROOT/dist/oar-extension.js"
  echo "    linked $EXT_DIR/cursor-omo.js (Cursor provider via local bridge)"
  echo "    linked $EXT_DIR/oar-usage-status.js (Grok/Codex remaining % footer)"
else
  echo "    skipped: $HOME_DIR/.omo/agent not found (OMO not installed for this user yet)"
fi

if [ "$SKIP_LAUNCHAGENT" -eq 0 ] && [ "$OS" = linux ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    echo "==> install systemd user unit ($SYSTEMD_UNIT)"
    mkdir -p "$SYSTEMD_DIR"
    sed \
      -e "s#__OAR_ROOT__#$ROOT#g" \
      -e "s#__BUN_BIN__#$BUN_BIN#g" \
      -e "s#__HOME__#$HOME_DIR#g" \
      "$SYSTEMD_TEMPLATE" > "$SYSTEMD_DIR/$SYSTEMD_UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now "$SYSTEMD_UNIT"
    echo "    installed + started $SYSTEMD_DIR/$SYSTEMD_UNIT"
    echo "    logs: journalctl --user -u $SYSTEMD_UNIT"
  else
    echo "==> skipped systemd unit (no systemd user session); the daemon is started on demand by oar daemon start"
  fi
elif [ "$SKIP_LAUNCHAGENT" -eq 0 ]; then
  echo "==> install LaunchAgent ($PLIST_LABEL)"
  mkdir -p "$LAUNCH_AGENTS_DIR"
  sed \
    -e "s#__OAR_ROOT__#$ROOT#g" \
    -e "s#__BUN_BIN__#$BUN_BIN#g" \
    -e "s#__HOME__#$HOME_DIR#g" \
    "$PLIST_TEMPLATE" > "$PLIST_TARGET"
  launchctl unload "$PLIST_TARGET" >/dev/null 2>&1 || true
  launchctl load -w "$PLIST_TARGET"
  echo "    installed + loaded $PLIST_TARGET"
  echo "    logs: $HOME_DIR/Library/Logs/oar-daemon.log"
else
  echo "==> skipped LaunchAgent install (--skip-launchagent)"
fi

if [ "$DO_IMPORT_AUTH" -eq 1 ]; then
  echo "==> import-auth --all --from $FROM_AUTH_JSON"
  if [ ! -f "$FROM_AUTH_JSON" ]; then
    echo "    skipped: $FROM_AUTH_JSON does not exist"
  else
    IMPORT_ARGS=(import-auth --all --from "$FROM_AUTH_JSON" --profile main)
    if [ "$FORCE_IMPORT" -eq 1 ]; then
      IMPORT_ARGS+=(--force)
    fi
    "$LOCAL_BIN/oar" daemon start || true
    "$LOCAL_BIN/oar" "${IMPORT_ARGS[@]}"
  fi
else
  echo "==> skipped import-auth (pass --import-auth to enable; never overwrites existing vault profiles unless --force)"
fi

echo "==> bootstrap multi-profile auto failover"
if [ -x "$LOCAL_BIN/oar" ]; then
  "$LOCAL_BIN/oar" daemon start >/dev/null 2>&1 || true
  "$LOCAL_BIN/oar" bootstrap-auto >/dev/null 2>&1 || true
fi

echo "==> live remaining usage"
if [ -x "$LOCAL_BIN/oar" ]; then
  "$LOCAL_BIN/oar" usage || echo "    usage lookup failed (run: oar usage)"
  echo "    keep it live: oar usage --watch   (or: oar panel --watch)"
fi

echo "==> done"
echo "Run: oar doctor"
echo "Full OMO+Cursor wire-up: bash $ROOT/scripts/bootstrap-omo-oar.sh"
echo "Auto account switch runs inside OMO (extension); manual oar use is optional."
