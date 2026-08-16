# OAR — OMO Account Router

**Languages:** [English](README.md) · [한국어](README.ko.md)

Local **multi-account hot-switch** for AI coding agents (OMO / Senpi first-class).

OAR does **not** pick models. Your agent still chooses provider/model.  
OAR chooses **which account** sits in the live auth slot — often **without restarting** the agent.

```text
YOU  →  omo / senpi  →  model request
                           ↑ getAuth every request
                      ~/.omo/agent/auth.json   ← one slot per provider
                           ↑ atomic activate
oar CLI  ──UDS──  oar-daemon  ──  ~/.oar/vault + state
```

| | |
|--|--|
| Status | Early public / personal toolkit |
| License | [MIT](LICENSE) |
| Runtime | [Bun](https://bun.sh) 1.3+ (Node 22+ ok for built `dist/`) |
| Compliance | [docs/compliance.md](docs/compliance.md) (**not legal advice**) |

---

## Why OAR?

| Pain | OAR |
|------|-----|
| Several Grok / Codex / Claude logins, painful re-login | Vault many profiles, `oar use` to activate one |
| Restart agent after every account change | Hot-switch via auth.json revision reload (Senpi/OMO) |
| “Which account is live? How much quota left?” | `oar panel` / `oar usage` tables |
| Hit limit mid-work | Optional `oar auto` failover (**off by default**, see compliance) |

---

## Requirements

- macOS or Linux
- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`)
- OMO / Senpi (or another agent that reads the same `auth.json` style) for hot-switch
- Accounts you **legitimately own** (never share credentials)

---

## Install

### A) npm — no git clone (recommended)

Requires **Node.js 22+**.

> The bare npm name `oar` is already taken by an unrelated package (Observable Array, 2013).  
> Install **`oar-cli`** — the shell command is still **`oar`**.

```bash
# npm registry (after publish)
npm install -g oar-cli

# GitHub archive (works without npm publish / login)
npm install -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
```

Then:

```bash
oar doctor
oar daemon start
oar panel --refresh
```

Optional macOS LaunchAgent + extension:

```bash
bash "$(npm root -g)/oar-cli/scripts/install.sh" --skip-build
# if installed from GitHub tarball the folder may still be named omo-account-router:
# bash "$(npm root -g)/omo-account-router/scripts/install.sh" --skip-build
```

Uninstall:

```bash
npm uninstall -g oar-cli
# or: npm uninstall -g omo-account-router
```

### B) Clone + install script (needs Bun)

```bash
git clone https://github.com/JIMyungSik/omo-account-router.git
cd omo-account-router
bash scripts/install.sh --import-auth
```

## Quick start (everyday)

### See everything

```bash
oar panel --refresh     # accounts + local signals + remote remaining %
oar usage --refresh
oar recommend --refresh  # ranked accounts by remaining %     # Codex week/5h + Grok subscription remaining
oar status              # simple active table
```

Example `oar usage` table:

```text
| PROVIDER     | PROFILE | OK  | 5H left | WK left | GROK left | USED | RESET         | SOURCE        |
|--------------|---------|-----|--------:|--------:|----------:|-----:|---------------|--------------|
| openai-codex | main    | yes |       - |      9% |         - |  91% | 08-20 12:37   | codex-wham   |
| xai          | sub     | yes |       - |       - |       97% |   3% | 08-22 10:32   | grok-billing |
```

- **5H** = Codex short/session window when the API exposes one (else `-`)
- **WK** = Codex weekly remaining
- **GROK** = xAI Grok **subscription** credit remaining (not Management API prepaid $)

### Switch account (no OMO restart)

```bash
oar use xai main
oar use xai sub
oar use openai-codex main
```

Running OMO sessions pick up the new slot on the **next** request.  
All parallel OMO windows share the **same** provider slot (global, not per-terminal).

### Import current login into vault

```bash
# one provider
oar import-auth xai main --from ~/.omo/agent/auth.json

# every provider currently in auth.json
oar import-auth --all
```

### Second account (same provider)

**Important:** the `omo` launcher always forces `SENPI_CODING_AGENT_DIR=~/.omo/agent`.  
Isolated second login must use **`senpi`**, not `omo`.

```bash
# 1) vault current account first
oar import-auth xai main

# 2) login account B in a temp dir
export OAR_TMP="$(mktemp -d)/agent"
mkdir -p "$OAR_TMP"
SENPI_CODING_AGENT_DIR="$OAR_TMP" senpi
# in TUI: /login → xAI → complete OAuth as account B → quit

# 3) import + restore live slot
oar import-auth xai sub --from "$OAR_TMP/auth.json"
rm -rf "$(dirname "$OAR_TMP")"
oar use xai main
oar status
```

`omo`-only path (temporarily overwrites live slot):

```bash
oar import-auth xai main
omo
# /logout xai → /login xai (account B) → quit
oar import-auth xai sub
oar use xai main
```

Full guide: `oar guide second-account` · [scripts/second-account.md](scripts/second-account.md)

### Optional auto-failover

```bash
oar auto xai on          # enable (OFF by default — read compliance!)
oar auto xai off
```

When enabled, classified failures (`RATE_LIMITED`, `QUOTA_EXHAUSTED`, `AUTH_REVOKED`, …) can activate another vaulted profile.  
This may conflict with provider Terms if used to pool subscription limits — **your responsibility**.

---

## Command reference

| Command | What it does |
|---------|----------------|
| `oar status` | Table of profiles + active `*` |
| `oar panel [--refresh] [--watch N] [--json] [--xbar]` | Full dashboard |
| `oar usage [provider] [profile] [--refresh]` | Remaining % table |
| `oar accounts [provider]` | JSON list |
| `oar add / remove <provider> <profile>` | Register metadata |
| `oar import-auth <p> <profile> [--from path]` | Copy auth.json slot → vault |
| `oar import-auth --all [--force]` | Import all providers |
| `oar use <p> <profile>` | Prefer + activate into live auth.json |
| `oar auto <p> on\|off` | Auto mode + failover flag |
| `oar login <p> <profile>` | Prints safe login steps (no token paste) |
| `oar logout <p> <profile>` | Mark revoked + remove vault entry |
| `oar test <p> <profile> [--live]` | Local health; optional live probe |
| `oar doctor` | Paths, engine versions, daemon |
| `oar daemon start\|stop\|status` | Daemon lifecycle |
| `oar install` | Runs `scripts/install.sh` |
| `oar guide second-account` | Second-account howto |

Environment:

| Var | Meaning |
|-----|---------|
| `OAR_HOME` | State root (default `~/.oar`) |
| `OAR_SOCK` | Unix socket path |
| `OAR_AUTH_PATH` | Single auth.json to write |
| `OAR_ACTIVATE_ALL=1` | Write all discovered auth.json files |

---

## How hot-switch works (OMO / Senpi)

Verified against omo-ai 5.x / senpi engine:

1. Launcher sets `SENPI_CODING_AGENT_DIR=~/.omo/agent`
2. Each model call → `getAuth` → reads `auth.json`
3. AuthStorage reloads when file revision changes
4. OAR activates vault credential into the provider key only (other providers untouched)

**Limits**

- One live slot per provider (not concurrent different accounts of the same provider in one process)
- Some providers (e.g. long-lived sockets) may need an extra request or reconnect
- Other agents (Orca, etc.) may use **different** account stores — OAR does not control those by default

---

## macOS menu bar (optional)

Install [SwiftBar](https://github.com/swiftbar/SwiftBar) or xbar, then:

```bash
mkdir -p "$HOME/Library/Application Support/SwiftBar"
ln -sf "$PWD/scripts/oar-xbar.sh" \
  "$HOME/Library/Application Support/SwiftBar/oar.5s.sh"
```

Refresh every 5s; click a profile row to `oar use` it.

---

## Development

```bash
bun install
bun test                 # unit + integration
bun run scripts/smoke-hot-switch.ts
bun run build            # dist/cli.js + dist/daemon-main.js
```

Layout:

```text
src/           CLI, daemon, router, adapters, usage fetchers
tests/         bun test
extensions/    thin Senpi extension (report + /account)
scripts/       install, uninstall, xbar, second-account guide
docs/          compliance, usage design notes
```

---

## Security

- Vault and socket use restrictive file modes
- Status/usage output must not print raw tokens
- See [SECURITY.md](SECURITY.md)

---

## Compliance

Using multiple subscriptions and auto-failover can conflict with provider Terms  
(e.g. circumventing rate limits). Read [docs/compliance.md](docs/compliance.md).  
**Not legal advice.**

---

## License

[MIT](LICENSE)
