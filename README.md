# OAR — OMO Account Router

**Languages:** [English](README.md) · [한국어](README.ko.md)

Local **multi-account hot-switch** for AI coding agents (**OMO / Senpi** first-class).

- Your agent still picks **provider + model**
- OAR picks **which account** sits in the live auth slot
- Usually **no agent restart** (next request picks up the new slot)

```text
YOU  →  omo / senpi  →  model request
                           ↑ getAuth every request
                      ~/.omo/agent/auth.json   ← one slot per provider
                           ↑ atomic activate
oar CLI  ──UDS──  oar-daemon  ──  ~/.oar/vault + state
```

| | |
|--|--|
| Package | **`oar-cli`** on npm path (command is still **`oar`**) |
| Version | `0.2.0` |
| License | [MIT](LICENSE) |
| Runtime | Node.js **22+** (Bun optional for dev) |
| Tests | `bun test` |
| Compliance | [docs/compliance.md](docs/compliance.md) (**not legal advice**) |
| Repo | https://github.com/JIMyungSik/omo-account-router |

> npm name bare `oar` is taken by an unrelated 2013 package. Install **`oar-cli`**; the binary is **`oar`**.

Verified against **OMO `5.0.0-0.beta.42` / Senpi `2026.9.4-3`**: header-only `after_provider_response` classification, and live `auth.json` writes merge instead of replacing native multi-account fields (`accounts`).

## Platforms

The CLI, daemon, and vault work on macOS, Linux, and Windows. Checked on 2026-09-24 with Bun 1.3.14:

| OS | How | Result |
|----|-----|--------|
| Linux arm64 | Docker `oven/bun:1.3.14`, `bun test` | 51 pass, 3 skip, 0 fail |
| Ubuntu | GitHub `ubuntu-latest`, `bun test` + style check | pass ([run 35945289044](https://github.com/JIMyungSik/omo-account-router/actions/runs/35945289044)) |
| Windows | GitHub `windows-latest`, same commands | pass (same run) |

`scripts/install.sh` and the LaunchAgent are macOS only. On Linux or Windows, build with Bun or Node 22 and run `oar daemon start` yourself. The default Argo secrets path is under `~/Library/Application Support`; on other systems set `OAR_ARGO_SECRETS_PATH` if that file exists.

---

## Install (no git clone)

### Recommended — GitHub archive

```bash
npm install -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
```

Requires **Node.js 22+**.

```bash
oar doctor
oar daemon start
oar panel --refresh
oar recommend --refresh
```

### After npm registry publish

```bash
npm install -g oar-cli
```

### Optional macOS always-on daemon + Senpi extension

```bash
# folder name depends on install source:
bash "$(npm root -g)/oar-cli/scripts/install.sh" --skip-build
# or:
bash "$(npm root -g)/omo-account-router/scripts/install.sh" --skip-build
```

### Uninstall

```bash
npm uninstall -g oar-cli
# or
npm uninstall -g omo-account-router
```

### Dev clone (Bun)

```bash
git clone https://github.com/JIMyungSik/omo-account-router.git
cd omo-account-router
bun install && bun test && bun run build
bash scripts/install.sh --import-auth
```

---

## Quick start

```bash
# snapshot
oar                         # status + freshly fetched remote remaining %
oar status                  # refresh credentials + quota before rendering
oar panel --refresh         # table: live slot + local signals + remote %
oar usage                   # fetch Codex 5h/week + Grok subscription remaining
oar recommend --refresh     # ranked “what to use next”

# subscription cost audit (manual monthly $ + usage heuristics)
oar subscriptions set xai main --monthly-usd 30 --plan "SuperGrok"
oar subscriptions audit --refresh

# vault current logins
oar import-auth --all

# switch account (hot)
# expired Codex/xAI OAuth is refreshed before the quota check
oar use xai sub
oar use openai-codex main

# 0% accounts are refused (even if auto is on)
oar use xai main            # REFUSED if remote remaining is 0%
oar use xai main --force    # override (not recommended)

# auto failover within a provider (off by default — read compliance)
oar auto xai on             # verified 0% preferred → positive-quota sibling
oar order xai main sub apple # user-defined failover order
oar auto xai off
```

Every account-facing command refreshes expired Codex/xAI OAuth credentials and
fetches current remote remaining percentages before it runs. Commands that
already own a remote-usage flow (`oar`, `oar usage`, `oar panel`,
`oar recommend`, and `oar use`) reuse that flow rather than issuing an extra
request. Help, version, and daemon lifecycle commands remain offline-safe.
An explicit `oar panel --no-remote` also skips credential and quota network calls.

### Second account (same provider)

**Do not use `omo` for isolated login** — the launcher forces `~/.omo/agent`.

```bash
oar import-auth xai main
export OAR_TMP="$(mktemp -d)/agent" && mkdir -p "$OAR_TMP"
SENPI_CODING_AGENT_DIR="$OAR_TMP" senpi
# TUI: /login → provider → second account → quit
oar import-auth xai sub --from "$OAR_TMP/auth.json"
rm -rf "$(dirname "$OAR_TMP")"
oar use xai main
```

Full guide: `oar guide second-account` · [scripts/second-account.md](scripts/second-account.md)

### Hidden logins inside one auth entry (xAI multi-login)

xAI can put several logins (Google + Sign-in-with-Apple, etc.) inside one
provider slot as an `accounts[]` array. OAR reads the **primary** (top-level)
token by default, so a live secondary login can look exhausted. Pick one
explicitly when importing:

```bash
# list what is inside (1=default, 2=login-2, ...)
oar import-auth xai apple --account 3          # by 1-based index
oar import-auth xai apple --account login-3    # or by name
oar usage xai apple --refresh && oar use xai apple
```

## Attach Argo and Buzz

OAR is not forked. One vault; `oar use` dual-writes the Senpi slot **and** existing Argo/Codex files. Design: [docs/sinks.md](docs/sinks.md)

| Surface | Provider | Sink | Notes |
|---------|----------|------|--------|
| Argo Grok | `xai` | `argo-grok` | `runners.grok` only |
| Argo host Codex | `openai-codex` | `codex-home` | Argo `runners.codex.type = host` reads host Codex |
| Buzz Codex | `openai-codex` | `codex-home` | default `~/.codex/auth.json` |
| Buzz Grok | — | **excluded** | `runtime: cursor` / Cursor pool, not the OAR xAI slot |

Prerequisites:

1. `oar daemon start` (or LaunchAgent — `oar doctor`)
2. Profile already in the vault (`oar import-auth` / `oar status`)
3. **The target file must already exist.** Log into Argo/Codex once yourself. OAR never creates those installs.

`oar use` prints each sink `id` / `status` / `path` / `detail` (no credentials). OMO activation still succeeds if a sink is skipped or errors (`wrote` / `skipped` / `error`).

### Argo (Grok / xAI)

Argo Grok does not read `~/.omo/agent/auth.json`. It stores:

`~/Library/Application Support/com.beyondworks.argo/workspaces/.account-secrets-local.json`  
plus per-workspace `…/workspaces/<id>/.secrets.json`

```json
{
  "runners": {
    "grok": {
      "type": "oauth",
      "value": "{\"access_token\":\"…\",\"refresh_token\":\"…\",\"expires_at\":1700000000000}"
    },
    "codex": { "type": "host", "value": "auto" }
  }
}
```

`expires_at` is milliseconds. Sibling runners (`codex`, `glm`, …) are left intact.

```bash
oar import-auth xai main
# second account: oar guide second-account, then:
# oar import-auth xai sub --from "$OAR_TMP/auth.json"

oar status
oar use xai sub
# expect: sink: argo-grok wrote <path>
# Restart Argo if it cached secrets at launch
```

Disable: `OAR_ARGO_SINK=0` or `OAR_SINKS=0`, then restart the daemon.

Argo **Codex** is `type: host` — it uses host Codex (`~/.codex`), same sink as Buzz Codex below. There is **no** Argo/Buzz-driven auto failover; only the OMO extension reports failures.

### Buzz / host Codex (`openai-codex`)

Buzz Codex agents here use `runtime: codex` / `codex-acp` with **no** `CODEX_HOME`. They inherit **`~/.codex/auth.json`**.

Native Codex `auth.json` must include `tokens.id_token`. Old Senpi-only vault profiles (access/refresh only) can reuse an ID token already on the Codex target when it belongs to the same account (access+refresh match). Otherwise `oar use` shows `sink: codex-home error missing_id_token`, leaves the file unchanged, and you need a native re-import (below).

**Main (current host Codex login, file-backed):**

```bash
mkdir -p "$HOME/.codex"
grep -q 'cli_auth_credentials_store *= *"file"' "$HOME/.codex/config.toml" 2>/dev/null \
  || printf 'cli_auth_credentials_store = "file"\n' >> "$HOME/.codex/config.toml"
codex -c 'cli_auth_credentials_store="file"' login
oar import-auth openai-codex main --from "$HOME/.codex/auth.json"
# or Senpi slot, if that copy already has idToken:
# oar import-auth openai-codex main
```

**Sub (isolated login home — do not export `CODEX_HOME`):**

```bash
OAR_CODEX_LOGIN=$(mktemp -d)
CODEX_HOME="$OAR_CODEX_LOGIN" codex -c 'cli_auth_credentials_store="file"' login
oar import-auth openai-codex sub --from "$OAR_CODEX_LOGIN/auth.json"
rm -rf "$OAR_CODEX_LOGIN"
# Cleanup is only the temp login dir. This does not change the daemon target;
# later daemons still write the existing host Codex file (~/.codex) unless you
# set OAR_CODEX_* on that daemon process (below).
oar use openai-codex sub
# new Buzz Codex turn or Codex CLI session; restart the app if it cached auth
```

If Buzz sets a private `CODEX_HOME`, the **daemon process** must see `OAR_CODEX_HOME` or `OAR_CODEX_AUTH_PATH`. A shell `export` does not reach a LaunchAgent.

**LaunchAgent** (`~/Library/LaunchAgents/com.victor.oar-daemon.plist`) only inherits its plist `EnvironmentVariables` (`HOME`, `PATH`, `OAR_HOME` by default). Edit that plist, then reload:

```bash
PLIST="$HOME/Library/LaunchAgents/com.victor.oar-daemon.plist"
# add OAR_CODEX_HOME and/or OAR_CODEX_AUTH_PATH under EnvironmentVariables, then:
launchctl unload "$PLIST"
launchctl load -w "$PLIST"
# modern equivalents:
# launchctl bootout "gui/$(id -u)/com.victor.oar-daemon"
# launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

**Shell-managed daemon:** unload/bootout the LaunchAgent first. KeepAlive will otherwise restart the agent and race the shell process.

```bash
launchctl unload "$HOME/Library/LaunchAgents/com.victor.oar-daemon.plist"
# or: launchctl bootout "gui/$(id -u)/com.victor.oar-daemon"

export OAR_CODEX_HOME=/path/to/that/home
# or: export OAR_CODEX_AUTH_PATH=/path/to/that/home/auth.json
oar daemon stop
oar daemon status   # must report down / not running
oar daemon start
oar use openai-codex sub
```

Do not treat `oar daemon stop; oar daemon start` as a reliable synchronous restart.

Daemon Codex path precedence: **`OAR_CODEX_AUTH_PATH` > `OAR_CODEX_HOME` > `CODEX_HOME` > `~/.codex`**.

| Env | Effect |
|------|--------|
| `OAR_SINKS=0` | Disable Argo + Codex sinks |
| `OAR_ARGO_SINK=0` | Argo off |
| `OAR_CODEX_SINK=0` | Codex home off |
| `OAR_ARGO_SECRETS_PATH` | Single Argo secrets JSON |
| `OAR_CODEX_AUTH_PATH` | Explicit Codex `auth.json` |
| `OAR_CODEX_HOME` | Parent of `auth.json` (daemon-visible) |
| `CODEX_HOME` | Same, if the daemon process sees it |

### Sink output / troubleshooting

```text
sink: argo-grok wrote /…/.secrets.json
sink: codex-home skipped no_codex_auth
sink: codex-home error missing_id_token
sink: argo-grok error …/bad.json: invalid_json
```

| Detail | Meaning |
|--------|---------|
| `wrote` | Target updated |
| `skipped` + `no_codex_auth` / `no_argo_secrets` | File missing — log into the app once |
| `skipped` + `unchanged` | Same Codex tokens already on disk |
| `error` + `missing_id_token` | Re-import native Codex `auth.json` (do not mint tokens) |
| `error` + `invalid_json` | Target left byte-for-byte unchanged |

Sink failures do not roll back the OMO slot. Missing files are skipped, not created. Apps that cache credentials need a restart or a new session after `oar use`. Fixture/smoke checks do **not** include live authenticated GUI or paid model requests.

### xAI `invalid_grant` after re-login

An xAI re-login can append a fresh `login-N` entry under `auth.json`'s
`accounts[]` while leaving the revoked top-level `default` credential active.
OAR account-facing commands (including `bootstrap-auto`) detect this only when
the newest slot, top-level slot, and preferred vault profile share the same JWT
subject. OAR then imports and activates the newer slot automatically while
preserving `accounts[]`. A different subject is never promoted.

Manual fallback:

```bash
oar import-auth xai main --account latest
oar use xai main
oar test xai main --live
```

`latest` selects the newest `login-N` slot. `oar use` then promotes the vault
credential into every live auth path. Do not paste or manually copy tokens.

---

## Command reference

| Command | Description |
|---------|-------------|
| `oar` | Status snapshot + freshly fetched remote remaining % |
| `oar status` | Profiles + active `*`, after refreshing remote usage |
| `oar panel [--refresh] [--watch N] [--json] [--xbar] [--no-remote]` | Full dashboard; fresh remote usage unless `--no-remote` |
| `oar usage [provider] [profile] [--refresh]` | Fetch and show remaining % table |
| `oar recommend [--refresh] [--json] [provider...]` | Ranked accounts by remaining % |
| `oar subscriptions list` | Configured monthly plan costs |
| `oar subscriptions set <p> <profile> --monthly-usd <n>` | Record plan cost |
| `oar subscriptions audit [--json] [--refresh]` | Keep/cancel heuristic + savings |
| `oar accounts [provider]` | JSON list |
| `oar import-auth <p> <profile> [--account <n\|name\|latest\|primary>]` | auth.json → vault. Default account is `latest` (highest `login-N`). A third argument or `--account` overrides it. `openai`/`codex`/`chatgpt` → `chatgpt-subscription`; `grok` → `xai` |
| `oar import-auth default [latest\|primary\|<slot>]` | Show or save the import slot default |
| `oar import-auth --all [--force]` | Import every provider (top-level token) |
| `oar who` | Which vault profile is actually in each live auth.json |
| `oar use <p> <profile> [--force]` | Prefer + activate. Writes every existing local auth.json and both Codex keys |
| `oar remove <p> <profile>` | Delete that vault profile. Also drops a matching live auth slot |
| `oar remove *` | Delete every vault account |
| `oar auto <p> on\|off` | Auto mode + failover flag |
| `oar order <p> [profile...]` | Show or replace failover order; list every profile when setting |
| `oar login` / `oar logout` | Login guide / remove vault |
| `oar test <p> <profile> [--live]` | Health check |
| `oar doctor` | Paths, engine, daemon tips |
| `oar daemon start\|stop\|status` | Daemon lifecycle |
| `oar install` | Runs `scripts/install.sh` |
| `oar guide second-account` | Second-account howto |

Environment: `OAR_HOME`, `OAR_SOCK`, `OAR_AUTH_PATH`, `OAR_ACTIVATE_ALL=1`, `OAR_SINKS`, `OAR_ARGO_SINK`, `OAR_CODEX_SINK`, `OAR_ARGO_SECRETS_PATH`, `OAR_CODEX_HOME`, `OAR_CODEX_AUTH_PATH`

---


## Other ADEs (Claude Code, Codex, Cursor, Orca, pi, gjc, …)

OAR is deepest on **OMO / Senpi**. Other tools vary.

| Tier | ADEs | OAR role |
|------|------|----------|
| First-class | OMO, Senpi | Hot-switch, extension, usage, recommend |
| Experimental | pi, omp, gjc, OpenCode* | `OAR_AUTH_PATH` / `OAR_ACTIVATE_ALL` if they use `auth.json` |
| Partial | Codex CLI, Argo Grok, Buzz Codex | `oar use` sinks — [docs/sinks.md](docs/sinks.md) |
| Separate | Cursor, Copilot, Orca, Buzz Grok, Gemini CLI, Aider, Cline… | Native UI; Buzz Grok is the Cursor pool |

\*if configured for shared Senpi-style auth

**Full matrix, setup recipes, and popularity notes:**  
→ **[docs/ades.md](docs/ades.md)** · [한국어](docs/ades.ko.md)

```bash
# Example: point OAR at another Senpi-like agent dir (shell-managed daemon)
export OAR_AUTH_PATH="$HOME/.pi/agent/auth.json"
oar daemon stop
oar daemon status   # must report down / not running
oar daemon start
oar use xai sub
```

## Behavior notes (important)

### Hot-switch
Parallel OMO windows share **one live slot per provider**.  
`oar use` applies on the **next** request (no restart).

### 0% / exhausted protection
- Remote usage 0% (Grok credits, etc.) → **warn + refuse** `oar use`
- With `oar auto <provider> on`, a verified 0% **preferred** account switches
  to a same-provider sibling whose remote usage fetch succeeded above 0%
- Positive observations are synchronized before exhausted observations, so a
  previously stale 0% sibling can recover and become the failover target
- Unknown/error usage is never treated as positive; a non-preferred 0% report
  does not trigger a switch
- When multiple positive siblings exist, `oar order <provider> ...` decides
  which one is selected first
- Auto failover **skips** every remaining `QUOTA_EXHAUSTED` account
- Grok **403 out of credits** is classified as quota exhausted (not success)
- Live `auth.json` is **re-aligned** on resolve if it drifted to another profile

### `oar recommend`
Ranks vault accounts (remote remaining % + eligibility).  
Prints a markdown table and:

```text
top pick: openai-codex/main  (100% left)
switch:   oar use openai-codex main
```

Does **not** change the session model — only which **account** OAR would activate.

### Scope
| In scope | Out of scope |
|----------|----------------|
| Account vault + hot-switch | Picking models for you |
| Usage % (Codex / Grok) | Orca’s own multi-account UI |
| Optional auto account failover | Guaranteed provider ToS compliance |

---

## macOS menu bar (optional)

[SwiftBar](https://github.com/swiftbar/SwiftBar) / xbar:

```bash
mkdir -p "$HOME/Library/Application Support/SwiftBar"
ln -sf "$(npm root -g)/oar-cli/scripts/oar-xbar.sh" \
  "$HOME/Library/Application Support/SwiftBar/oar.5s.sh"
```

---

## Development

```bash
bun install
bun test
bun run scripts/smoke-hot-switch.ts
bun run scripts/smoke-sinks.ts
bun run build
```

```text
src/           CLI, daemon, router, adapters, usage, recommend
tests/         bun test
extensions/    Senpi extension (report + /account)
scripts/       install, xbar, guides
docs/          compliance, design, npm publish notes
dist/          shipped Node build (for npm install without Bun)
```

Publish notes: [docs/npm-publish.md](docs/npm-publish.md)

Contributions use protected `main` + pull requests only. See
[CONTRIBUTOR.md](CONTRIBUTOR.md).

---

## Security & compliance

- Vault/socket use restrictive permissions; never log raw tokens  
- [SECURITY.md](SECURITY.md)  
- Multi-subscription auto-rotation may conflict with provider Terms — [docs/compliance.md](docs/compliance.md)

---

## License

[MIT](LICENSE)
