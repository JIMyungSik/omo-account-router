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
| Version | `0.1.4` |
| License | [MIT](LICENSE) |
| Runtime | Node.js **22+** (Bun optional for dev) |
| Tests | `bun test` — 47 pass |
| Compliance | [docs/compliance.md](docs/compliance.md) (**not legal advice**) |
| Repo | https://github.com/JIMyungSik/omo-account-router |

> npm name bare `oar` is taken by an unrelated 2013 package. Install **`oar-cli`**; the binary is **`oar`**.

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
oar                         # quick status (no args)
oar status
oar panel --refresh         # table: live slot + local signals + remote %
oar usage --refresh         # Codex 5h/week + Grok subscription remaining
oar recommend --refresh     # ranked “what to use next”

# vault current logins
oar import-auth --all

# switch account (hot)
oar use xai sub
oar use openai-codex main

# 0% accounts are refused (even if auto is on)
oar use xai main            # REFUSED if remote remaining is 0%
oar use xai main --force    # override (not recommended)

# auto failover within a provider (off by default — read compliance)
oar auto xai on
oar auto xai off
```

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

---

## Command reference

| Command | Description |
|---------|-------------|
| `oar` | Quick status snapshot |
| `oar status` | Profiles + active `*` |
| `oar panel [--refresh] [--watch N] [--json] [--xbar]` | Full dashboard table |
| `oar usage [provider] [profile] [--refresh]` | Remaining % table |
| `oar recommend [--refresh] [provider...]` | Ranked accounts by remaining % |
| `oar accounts [provider]` | JSON list |
| `oar import-auth <p> <profile> [--from path]` | auth.json → vault |
| `oar import-auth --all [--force]` | Import every provider |
| `oar use <p> <profile> [--force]` | Prefer + activate (blocks 0%) |
| `oar auto <p> on\|off` | Auto mode + failover flag |
| `oar login` / `oar logout` | Login guide / remove vault |
| `oar test <p> <profile> [--live]` | Health check |
| `oar doctor` | Paths, engine, daemon tips |
| `oar daemon start\|stop\|status` | Daemon lifecycle |
| `oar install` | Runs `scripts/install.sh` |
| `oar guide second-account` | Second-account howto |

Environment: `OAR_HOME`, `OAR_SOCK`, `OAR_AUTH_PATH`, `OAR_ACTIVATE_ALL=1`

---

## Behavior notes (important)

### Hot-switch
Parallel OMO windows share **one live slot per provider**.  
`oar use` applies on the **next** request (no restart).

### 0% / exhausted protection
- Remote usage 0% (Grok credits, etc.) → **warn + refuse** `oar use`
- Auto failover **skips** `QUOTA_EXHAUSTED` accounts
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

---

## Security & compliance

- Vault/socket use restrictive permissions; never log raw tokens  
- [SECURITY.md](SECURITY.md)  
- Multi-subscription auto-rotation may conflict with provider Terms — [docs/compliance.md](docs/compliance.md)

---

## License

[MIT](LICENSE)
