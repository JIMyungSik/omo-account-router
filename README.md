# OAR — OMO Account Router

Senpi-native **runtime AI account routing** for **omo-ai 5.x** (`5.0.0-0.beta.7` / engine `senpi@2026.8.12-4`).

OMO/Senpi still chooses **member + provider/model**. OAR chooses **which account** of that provider sits in the live Senpi `auth.json` slot — without restarting OMO.

## Why hot-switch does not restart OMO

Verified against installed engine files:

1. `omo` → launcher spawns senpi with `SENPI_CODING_AGENT_DIR=~/.omo/agent` (**always forced by launcher**)
2. `ModelRuntime.stream` → `prepareRequest` → **`getAuth` on every request**
3. `AuthStorage` reloads `auth.json` when file revision changes
4. Provider HTTP clients are built per stream from that auth (xAI and similar)

```
USER → omo-ai 5.x → Senpi → ModelRuntime.getAuth (per request)
                              ↑ revision-aware read
                         ~/.omo/agent/auth.json  (one slot / provider)
                              ↑ atomic activate
OAR CLI ──UDS ~/.oar/oar.sock── OAR Daemon ── vault + state (~/.oar)
```

## Install (P0 ops)

```bash
cd omo-account-router
bash scripts/install.sh --import-auth
# or: bun run src/cli.ts install -- --import-auth

oar doctor
oar status
```

What install does:

1. `bun install` + `bun run build`
2. Symlink `~/.local/bin/oar` → `bin/oar-wrapper.sh`
3. Symlink `~/.omo/agent/extensions/oar.js` → `extensions/oar-senpi.js`
4. Install + load LaunchAgent `com.victor.oar-daemon` (`RunAtLoad` + `KeepAlive`)
5. Optional: `oar import-auth --all` (skips existing vault profiles unless `--force`)

Uninstall: `bash scripts/uninstall.sh`

## Daily commands

| Command | Purpose |
|--------|---------|
| `oar status` | Accounts / active ★ |
| `oar accounts [provider]` | JSON list |
| `oar import-auth <p> <profile> [--from path]` | Vault one slot |
| `oar import-auth --all [--from path] [--profile main] [--force]` | Vault every provider in auth.json |
| `oar use <p> <profile>` | Prefer + activate into live auth.json |
| `oar auto <p> on|off` | Mode + autoFailover (default **off**) |
| `oar login <p> <profile>` | Prints login steps (no token paste) |
| `oar guide second-account` | Second-account procedure |
| `oar test <p> <profile> [--live]` | Metadata health; `--live` = optional HTTP probe |
| `oar doctor` | Paths, engine versions, daemon |
| `oar daemon start|stop|status` | Manual daemon control |
| `oar install` | Runs `scripts/install.sh` |

## Second account (you must do the browser login)

Full guide: [`scripts/second-account.md`](scripts/second-account.md) · CLI: `oar guide second-account`

**Short version (xAI example):**

```bash
# 1) vault current live account
oar import-auth xai main

# 2) isolated login via senpi (NOT omo — launcher ignores temp dirs)
export OAR_TMP_LOGIN_DIR="$(mktemp -d)/agent"
mkdir -p "$OAR_TMP_LOGIN_DIR"
SENPI_CODING_AGENT_DIR="$OAR_TMP_LOGIN_DIR" senpi
# in TUI: /login → xAI → complete OAuth as the SECOND account → quit

# 3) import + switch
oar import-auth xai account-b --from "$OAR_TMP_LOGIN_DIR/auth.json"
rm -rf "$(dirname "$OAR_TMP_LOGIN_DIR")"
oar use xai account-b
oar status
```

Live A→B API proof is only possible after step 3 succeeds with two vault profiles.

## Design limits (P2)

| Limit | Detail |
|------|--------|
| One live slot per provider | Concurrent different accounts of the same provider in one process are not supported |
| Auto failover default OFF | `oar auto <p> on` only fails over when another vault credential exists |
| `oar test` vs `--live` | Default = local vault/expiry metadata only. `--live` is best-effort HTTP and does **not** mutate routing state |
| `omo` vs `senpi` | `omo` always pins agent dir to `~/.omo/agent`. Isolated second login must use `senpi` + env, or temporary `/logout`+`/login` on the live dir |
| Packaging | `dist/` is gitignored; install/build before relying on LaunchAgent (`dist/daemon-main.js`) |
| Refresh coverage | xAI / Anthropic / OpenAI-Codex implement OAuth refresh under the daemon lock. OpenRouter / api_key providers: hot-switch only (no invented refresh) |

## Policy

- No CAPTCHA / fingerprint / abuse bypass
- Secrets only under `~/.oar/vault` mode `0600` — never logged
- IPC status paths never return raw credentials
- Model routing stays in OMO/Senpi

## Tests

```bash
bun test
bun run scripts/smoke-hot-switch.ts
bun run build
```

Covers: real Senpi AuthStorage hot-switch, multi-client daemon, AUTH_REVOKED routing, OAuth refresh single-flight (xAI + mocked Anthropic/Codex), leases, daemon restart reconnect, import-auth --all, generic adapters.

## Adapters

| Provider | Hot-switch | OAR refresh | Notes |
|----------|------------|-------------|-------|
| `xai` | yes | yes | Primary target |
| `anthropic` | yes | yes | Public OAuth client id (same as senpi pi-ai) |
| `openai-codex` | yes | yes | Preserves `accountId` |
| `openrouter` | yes | no | Long-lived key shaped as oauth |
| `opencode-go`, `zai-coding-cn`, others | yes | no | Generic adapter |

## Panel / dashboard (selection + local usage signals)

```bash
oar panel                 # one-shot table
oar panel --watch 2       # refresh every 2s
oar panel --json          # machine readable
oar panel --hours 48      # event window (default 24h)
oar panel --xbar          # SwiftBar / xbar menubar output
```

Columns:

- **★** live/resolved account for that provider (shared by all parallel omo sessions)
- **MODE / AUTO** manual|auto and failover flag
- **OK / RL / QUOTA / AF** counts from local `~/.oar/events.jsonl` in the window  
  (SUCCESS / RATE_LIMITED / QUOTA_EXHAUSTED / auth failures reported by the OMO extension)

This is **not** ChatGPT/Grok/Claude billing dashboards. Provider residual quota/$ APIs are not wired yet (`supportsUsageQuery` is still false). The panel shows **which account is selected** and **local health/usage signals** OAR already observes.

### macOS menu bar (SwiftBar or xbar)

1. Install [SwiftBar](https://github.com/swiftbar/SwiftBar) or xbar
2. Link the plugin (refresh every 5s via filename):

```bash
# SwiftBar
mkdir -p "$HOME/Library/Application Support/SwiftBar"
ln -sf "$PWD/scripts/oar-xbar.sh" "$HOME/Library/Application Support/SwiftBar/oar.5s.sh"

# xbar
mkdir -p "$HOME/Library/Application Support/xbar/plugins"
ln -sf "$PWD/scripts/oar-xbar.sh" "$HOME/Library/Application Support/xbar/plugins/oar.5s.sh"
```

Menu shows active profiles; click a profile row to `oar use` that account (via plugin action).
