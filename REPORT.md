# OAR Final Report — OMO Account Router (Phase 0–2+ MVP, repo v0.1.5)

## 1. Senpi Architecture Discovered

| Item | Fact |
|------|------|
| OMO | `omo-ai@5.0.0-0.beta.7` → launches senpi with brand |
| Engine | `@code-yeongyu/senpi@2026.8.12-4` |
| Brand | `configDir=.omo`, `flatLayout=true`, `envPrefix=OMO` |
| Agent dir | Launcher sets `SENPI_CODING_AGENT_DIR=~/.omo/agent` (legacy prefix still read by `envValue`) |
| Auth path | `getAuthPath()` = `join(getAgentDir(), "auth.json")` → typically `~/.omo/agent/auth.json` |
| Credential store | `AuthStorage` (`dist/core/auth-storage.js`) + `FileAuthStorageBackend` + `proper-lockfile` |
| Hot reload | `readLatestData()` compares `getFileRevision` (`dev:ino:size:mtimeNs:ctimeNs`) and reloads |
| Model invoke | `ModelRuntime.stream` → `lazyStream` → **`prepareRequest` → `getAuth` per request** |
| Multi-account native | **No** — one credential slot per provider id in `auth.json` |
| Observed providers in auth | `xai`, `anthropic`, `openai-codex`, `openrouter`, api keys… |

## 2. Integration Point

**Primary (hot switch, no restart):**  
OAR Daemon activates vault credential into Senpi/OMO **`auth.json` provider slot**.

Exact Senpi symbols:

- `ModelRuntime.prepareRequest` / `getAuth` — `senpi/dist/core/model-runtime.js`
- `AuthStorage.read` / `readLatestData` / `getFileRevision` — `senpi/dist/core/auth-storage.js`

**Secondary (UX):**  
Thin extension `extensions/oar-senpi.js` registers `/account status|use|auto|doctor` over UDS.  
Does **not** replace model routing.

**Not used:** OpenCode plugin fork, process restart, env-only API key swap requiring terminal restart.

## 3. Hot Switching Mechanism

```
oar use xai account-b
  → daemon sets preferred profile
  → AuthSlotActivator atomic-writes credential into auth.json[xai]
  → next ModelRuntime.stream call
  → getAuth → AuthStorage.read → revision mismatch → reload
  → Account B tokens used
```

Conversation / session JSONL / tasks / worktrees are **not** touched.

**OMO restart required: NO**  
**Senpi restart required: NO**  
**Terminal restart required: NO**

## 4. Architecture

```
USER
  ↓
OMO-AI 5.x launcher (--extension omo plugin)
  ↓
Senpi Runtime / members (model routing stays here)
  ↓
ModelRuntime.prepareRequest → getAuth (per request)
  ↓ reads revision-aware auth.json
~/.omo/agent/auth.json   ← provider slot (one active identity)
  ↑ atomic activate
OAR CLI ── Unix Domain Socket ~/.oar/oar.sock ── OAR Daemon
                                                    ├ state.json
                                                    ├ vault/ (0600)
                                                    ├ router
                                                    ├ refresh lock
                                                    └ adapters (xai…)
```

## 5. Provider Support

| | Grok/xAI | Claude | Codex |
|--|----------|--------|-------|
| Hot switch | YES (auth.json slot) | YES (same mechanism; adapter thin) | YES (same) |
| Auto failover | OFF by default (`supportsAutoFailover=false`) | OFF default | OFF default |
| OAuth | stored oauth access/refresh/expires | oauth | oauth |
| Usage detection | no guessing | no guessing | no guessing |
| Auth method | OAuth (Senpi builtin refresh path still in-process; central refresh planned) | OAuth | OAuth |
| Known limitation | Live multi-account vault needs `import-auth` per owned profile; live xAI token refresh endpoint not fully wired (daemon lock ready) | login UX still Senpi `/login` | accountId field preserved if present |

## 6. OMO/Senpi Integration

- Default path: user runs `omo` as usual; after `oar use`, next provider request uses new account.
- Optional: `/account …` via `oar-senpi.js`.
- Members (Librarian→Grok etc.) unchanged; OAR only selects **which Grok account**.

## 7. Multi-Process

All OMO processes share:

1. Same `auth.json` activation target(s)
2. OAR daemon state over UDS

`oar use` from any shell updates daemon preferred + auth slot → every OMO’s next `getAuth` sees new revision.

## 8. Multi-Member

Refresh single-flight: `AccountRefreshLock` in daemon (`refresh-lock.ts`).  
Account leases / maxConcurrent: data model field present; enforcement Phase 3+.

## 9. OAuth Race Protection

- File lock on auth.json writes (`proper-lockfile` in Senpi + atomic rename in OAR activator)
- Daemon `AccountRefreshLock.withLock(accountKey)` — 10 concurrent callers → 1 refresh (tested)
- New tokens should be written only under lock into vault + auth slot (live refresh endpoint TBD)

## 10. Commands

```
oar status | accounts | provider list
oar add <provider> <profile>
oar import-auth <provider> <profile> [--from auth.json]
oar use <provider> <profile>
oar auto <provider> on|off
oar activate | report | doctor
oar daemon start|stop|status
```

## 11. Test Results

| Test | Result | Evidence |
|------|--------|----------|
| Hot Switch | PASS | `tests/hot-switch.test.ts` + `scripts/smoke-hot-switch.ts` `{"afterA":"tok-A","afterB":"tok-B","pass":true}` |
| Multi-OMO / multi-client | PASS | `tests/multi-client.test.ts` |
| Failover classify / AUTH_REVOKED | PASS | `tests/classifier.test.ts` + `tests/router.test.ts` |
| OAuth concurrency | PASS | `tests/refresh-lock.test.ts` refreshCalls=1 |
| Context preservation | PASS (by design + PoC) | activator only rewrites provider key in auth.json; sessions dir untouched |
| Daemon restart | reconnect via next CLI call; OMO need not restart | `oar daemon start` |

Full suite (current tree): **52 pass / 0 fail** (`bun test`, 17 files).
Smoke: `bun run scripts/smoke-hot-switch.ts` → `pass: true` (tok-A → tok-B).
Real Senpi AuthStorage: `tests/senpi-auth-storage.hot-switch.test.ts` PASS (child daemon switch; parent AuthStorage reload without restart).

## 12. Restart Requirement

```
OMO restart required:     NO
Senpi restart required:   NO
Terminal restart required: NO
```

Caveat: if a provider client **outside** Senpi AuthStorage cached tokens independently (not observed in stock path), that path would need separate invalidation. Stock omo-ai 5.x / senpi path does not.

## Project path

`/Users/victor/_02_business/_03_program/omo-account-router`
