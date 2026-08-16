# OAR — OMO Account Router

Senpi-native **runtime AI account routing** for **omo-ai 5.x** (`5.0.0-0.beta.7` / engine `senpi@2026.8.12-4`).

This is not an OpenCode plugin, not a restart-required profile switcher, and not a model router. OMO/Senpi still chooses **member + provider/model**. OAR chooses **which account** of that provider is in the live Senpi auth slot.

## Why hot-switch does not restart OMO

Verified against installed files (not guessed):

1. `omo` → `omo-ai/bin/lib/launcher.js` spawns `senpi/dist/cli.js --extension omo-ai/plugin` with `SENPI_CODING_AGENT_DIR=~/.omo/agent`
2. `ModelRuntime.stream` → `prepareRequest` → **`getAuth` on every request** (`senpi/dist/core/model-runtime.js`)
3. `AuthStorage.read` / `readLatestData` reloads `auth.json` when file revision `dev:ino:size:mtimeNs:ctimeNs` changes (`senpi/dist/core/auth-storage.js`)
4. xAI HTTP clients are **created per stream**, not a process singleton (`pi-ai/dist/api/openai-completions.js`)

So: vault many accounts in OAR, activate one into the provider slot in `~/.omo/agent/auth.json`. The next model call in the **same Senpi session** picks it up. Conversation / task / memory / worktree files are not touched.

```
USER → omo-ai 5.x → Senpi Runtime → Member (model already chosen)
                                      ↓
                                 ModelRuntime.getAuth (per request)
                                      ↑ revision-aware read
                                 ~/.omo/agent/auth.json  (one slot / provider)
                                      ↑ atomic activate
OAR CLI ──UDS ~/.oar/oar.sock── OAR Daemon ── vault + state (~/.oar)
```

## Phase 1 answer

**Can the same Senpi session keep running while the provider account changes at runtime?**

**YES** for xAI/Grok (and any provider whose client is built from `getAuth` per request). Mechanism: auth.json slot + AuthStorage revision reload.

**Live Grok Account A → Account B API proof** needs a second imported xAI credential. This machine currently has **one** `xai` slot. Import a second profile, then `oar use xai account-b`.

## Install / run

```bash
cd omo-account-router
bun test

export OAR_HOME=~/.oar
bun run src/cli.ts daemon start
bun run src/cli.ts doctor
bun run src/cli.ts add xai account-a
bun run src/cli.ts import-auth xai account-a --from ~/.omo/agent/auth.json
# after logging a second Grok account into a temp auth.json:
bun run src/cli.ts import-auth xai account-b --from /path/to/other/auth.json
bun run src/cli.ts use xai account-b
```

Optional Senpi commands: link `extensions/oar-senpi.js` into `~/.omo/agent/extensions/`.

## Commands

| Command | Purpose |
|--------|---------|
| `oar status` | Table of accounts / active |
| `oar accounts [provider]` | JSON list |
| `oar add / remove` | Register / drop profile |
| `oar import-auth` | Copy current slot into vault |
| `oar login` | Prints Senpi login + import steps (no token paste) |
| `oar logout` | Drop vault profile |
| `oar use <provider> <profile>` | Prefer + activate into auth.json |
| `oar auto <provider> on\|off` | Mode + autoFailover (default **off**) |
| `oar test` | Local credential metadata health (no inference) |
| `oar report` | Event-driven state update |
| `oar doctor` | Paths + engine versions + daemon |
| `oar daemon start\|stop\|status` | Daemon lifecycle |

## Policy

- Auto multi-account failover **defaults OFF**.
- No CAPTCHA / fingerprint / abuse bypass.
- Secrets in `~/.oar/vault` mode `0600` — never logged.
- IPC does not return raw credentials to CLI status output.
- Model routing stays in OMO/Senpi.

## Tests

```bash
bun test
bun run scripts/smoke-hot-switch.ts
```

Covers: real Senpi AuthStorage hot-switch, multi-client daemon, AUTH_REVOKED routing, OAuth refresh single-flight, leases, daemon restart reconnect.
