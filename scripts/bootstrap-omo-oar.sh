#!/usr/bin/env bash
# Wire OAR auto-account switching + Cursor provider into the live OMO agent dir.
# After this, day-to-day use does not require typing `oar` commands.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${SENPI_CODING_AGENT_DIR:-$HOME/.omo/agent}"
EXT_DIR="$AGENT_DIR/extensions"
BIN_DIR="${HOME}/.local/bin"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"

mkdir -p "$EXT_DIR" "$BIN_DIR" "$HOME/Library/Logs"

echo "==> OAR daemon install"
bash "$ROOT/scripts/install.sh" --skip-build 2>/dev/null || bash "$ROOT/scripts/install.sh"

echo "==> Link OMO extensions"
ln -sfn "$ROOT/extensions/oar-senpi.js" "$EXT_DIR/oar.js"
ln -sfn "$ROOT/extensions/cursor-omo.js" "$EXT_DIR/cursor-omo.js"
echo "    $EXT_DIR/oar.js -> oar-senpi.js"
echo "    $EXT_DIR/cursor-omo.js"

echo "==> cursor-bridge wrapper"
cat > "$BIN_DIR/oar-cursor-bridge" <<EOF
#!/usr/bin/env bash
exec env PATH="\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH" \\
  node "$ROOT/scripts/cursor-bridge.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/oar-cursor-bridge"

if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST="$LAUNCH_AGENTS/com.victor.oar-cursor-bridge.plist"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.victor.oar-cursor-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_DIR/oar-cursor-bridge</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/oar-cursor-bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/oar-cursor-bridge.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/com.victor.oar-cursor-bridge" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  echo "    LaunchAgent com.victor.oar-cursor-bridge loaded"
fi

echo "==> Enable multi-profile auto failover (no manual oar use)"
if command -v oar >/dev/null 2>&1; then
  oar daemon start >/dev/null 2>&1 || true
  # Call bootstrap via daemon using a tiny node client if oar CLI lacks the command yet.
  if oar --help 2>/dev/null | grep -q bootstrap; then
    oar bootstrap-auto || true
  else
    node --input-type=module <<'NODE'
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
const sock = process.env.OAR_SOCK || join(homedir(), ".oar", "oar.sock");
const body = Buffer.concat([Buffer.from(JSON.stringify({ protocol: 1, action: "bootstrap-auto" })), Buffer.from([0])]);
await new Promise((resolve, reject) => {
  const s = createConnection(sock);
  let buf = Buffer.alloc(0);
  s.on("connect", () => s.write(body));
  s.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    const i = buf.indexOf(0);
    if (i === -1) return;
    console.log(buf.subarray(0, i).toString("utf8"));
    s.end();
    resolve();
  });
  s.on("error", reject);
});
NODE
  fi
fi

echo "==> Done"
echo "Restart OMO once so extensions load."
echo "Auto account switch: multi-profile providers use mode=auto (no oar CLI)."
echo "Cursor models: cursor/cursor-grok-4.6-high etc. via bridge :18765"
echo "Health: curl -s http://127.0.0.1:18765/health && oar doctor"
