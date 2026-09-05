# ADE sinks — Argo Grok + Codex home (Buzz)

OAR vault stays the source of truth. Senpi `auth.json` stays the live OMO slot.
Argo and Buzz do **not** read that file, so `oar use` also dual-writes **sinks**.

This is not a second router. No Senpi extension, no failover loop inside Argo/Buzz.
Those apps keep their own UI. OAR only copies the already-selected vault profile.

```
oar use <provider> <profile>
        │
        ├─ Senpi/OMO  ~/.omo/agent/auth.json     (existing)
        ├─ Argo       runners.grok  (xai only)
        └─ Codex CLI  auth.json                  (openai-codex only)
                      default ~/.codex = Buzz Codex + Argo host Codex
```

## Support matrix

| Surface | Provider | Sink | In scope |
|---------|----------|------|----------|
| Argo Grok | `xai` | `argo-grok` | yes |
| Argo host Codex | `openai-codex` | `codex-home` | yes (`runners.codex.type = host`) |
| Buzz Codex | `openai-codex` | `codex-home` | yes |
| Buzz Grok | Cursor pool | — | **no** |

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Architecture | Sink writers on `activate` | Same command path as OMO hot-switch |
| Fail open | Sink errors do not roll back Senpi write | OMO must keep working if Argo/Buzz files are locked |
| Create files? | Never. Write only if the target already exists | Do not invent an Argo/Codex install |
| Disable | `OAR_SINKS=0`, `OAR_ARGO_SINK=0`, `OAR_CODEX_SINK=0` | Opt-out without uninstall |
| Auto failover | Unchanged (OMO extension only) | Argo/Buzz do not emit OAR `report` |
| Reload | Cold for Argo/Buzz if they cache at launch | Restart that app / new session after `oar use` |
| Codex ID token | Import or same-account preserve only | Native Codex CLI requires `tokens.id_token`. Never mint one |
| Visibility | `oar use` prints `sink: id status [path] [detail]` | No credentials in the line |

## 1. Argo × xAI

**Observed (argo 0.1.54):**

- `~/Library/Application Support/com.beyondworks.argo/workspaces/.account-secrets-local.json`
- per-workspace `.secrets.json` (same `runners` shape)
- `runners.grok = { type: "oauth", value: "<json string>" }`
- value JSON: `{ access_token, refresh_token, expires_at }` (`expires_at` = ms epoch)
- `runners.codex.type = "host"` (host Codex login — Codex sink, not this writer)
- `runners.glm.type = "apikey"` (untouched)

**Map from OAR `xai` oauth credential:**

| Vault | Argo grok value |
|---|---|
| `access` | `access_token` |
| `refresh` | `refresh_token` |
| `expires` | `expires_at` (milliseconds) |

Write rules:

- Provider must be `xai` and credential `type === "oauth"`.
- Keep sibling runners (`codex`, `glm`) and unknown keys.
- Replace `runners.grok` only when that key already exists.
- Atomic write, mode `0600`.
- Override path: `OAR_ARGO_SECRETS_PATH` (tests / non-default layout).
- Malformed JSON → `error` / `invalid_json`, file left byte-for-byte unchanged.
- A partial multi-file write keeps `status: wrote` and retains the error detail for the failed path.

```bash
oar import-auth xai main
oar import-auth xai sub --from "$OAR_TMP/auth.json"
oar use xai sub
```

## 2. Buzz Codex / host Codex × `CODEX_HOME`

Buzz Codex agents on this machine use `runtime: "codex"` / `agent_command: "codex-acp"` and do **not** set `CODEX_HOME`. They inherit the host CLI home: `~/.codex/auth.json`. Argo host Codex uses the same file.

**Observed Codex CLI `auth.json` (readable shape):**

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<jwt>",
    "access_token": "<jwt>",
    "refresh_token": "<token>",
    "account_id": "<chatgpt-account-id>"
  },
  "last_refresh": "2026-09-05T00:00:00.000Z"
}
```

A file missing `tokens.id_token` is rejected by Codex CLI (`missing field id_token`). OAR will not write that shape.

**Map from OAR `openai-codex` oauth credential:**

| Vault | Codex auth.json |
|---|---|
| `access` | `tokens.access_token` |
| `refresh` | `tokens.refresh_token` |
| `accountId` | `tokens.account_id` (never inherit another account’s id) |
| `idToken` | `tokens.id_token` (imported, or preserved only for the same identity) |
| — | `auth_mode` = `"chatgpt"` when valid OAuth is selected |
| — | `OPENAI_API_KEY` = `null` when valid OAuth is selected |
| — | `last_refresh` = now, unless the write would be identical |
| — | unknown top-level fields are preserved |

If the selected account has no ID token, the sink returns `error` / `missing_id_token` and leaves the target unchanged. No network refresh runs during a sink write.

### Import

Senpi slot (compatible, including optional `idToken`):

```bash
oar import-auth openai-codex main
```

Native Codex `auth.json` (ID token + account id; expiry from access-token JWT `exp`). File store is required if this machine uses the OS keyring:

```bash
mkdir -p "$HOME/.codex"
grep -q 'cli_auth_credentials_store *= *"file"' "$HOME/.codex/config.toml" 2>/dev/null \
  || printf 'cli_auth_credentials_store = "file"\n' >> "$HOME/.codex/config.toml"
codex -c 'cli_auth_credentials_store="file"' login
oar import-auth openai-codex main --from "$HOME/.codex/auth.json"
```

Second account in an isolated login home. Do **not** export `CODEX_HOME` — that would redirect later daemons.

```bash
OAR_CODEX_LOGIN=$(mktemp -d)
CODEX_HOME="$OAR_CODEX_LOGIN" codex -c 'cli_auth_credentials_store="file"' login
oar import-auth openai-codex sub --from "$OAR_CODEX_LOGIN/auth.json"
rm -rf "$OAR_CODEX_LOGIN"
```

After a successful import, delete the temp login directory. This does not change the daemon target; later daemons still write the existing host Codex file (`~/.codex`) unless that daemon process has `OAR_CODEX_*`.

`--all` also recognizes a native Codex file and imports it as `openai-codex` only.

### ID-token migration (old Senpi-only vault)

Profiles imported before ID tokens were stored can reuse the ID token already on the Codex target when access+refresh match that same account. Otherwise they cannot be dual-written. Re-import from native Codex `auth.json` (or a Senpi slot that already has `idToken`). Do not invent unsigned ID tokens.

### Daemon path precedence

`OAR_CODEX_AUTH_PATH` > `OAR_CODEX_HOME` > `CODEX_HOME` > `~/.codex/auth.json`

The daemon process must see these variables. A shell `export` does not reach LaunchAgent.

**LaunchAgent** (`~/Library/LaunchAgents/com.victor.oar-daemon.plist`) only gets plist `EnvironmentVariables` (`HOME`, `PATH`, `OAR_HOME` by default). Add `OAR_CODEX_*` there, then reload:

```bash
PLIST="$HOME/Library/LaunchAgents/com.victor.oar-daemon.plist"
launchctl unload "$PLIST"
launchctl load -w "$PLIST"
# modern equivalents:
# launchctl bootout "gui/$(id -u)/com.victor.oar-daemon"
# launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

**Shell-managed daemon:** unload/bootout the LaunchAgent first so KeepAlive cannot race a terminal `oar daemon start`.

```bash
launchctl unload "$HOME/Library/LaunchAgents/com.victor.oar-daemon.plist"
# or: launchctl bootout "gui/$(id -u)/com.victor.oar-daemon"
oar daemon stop
oar daemon status   # must report down / not running
oar daemon start
```

Do not treat `oar daemon stop; oar daemon start` as a reliable synchronous restart.

## 3. CLI outcome

```text
openai-codex sub is now preferred. …
auth slot: /Users/…/.omo/agent/auth.json
sink: codex-home wrote /Users/…/.codex/auth.json
```

Statuses: `wrote` | `skipped` | `error`. Details are stable codes (`no_codex_auth`, `missing_id_token`, `invalid_json`, `unchanged`), not JSON.parse snippets.

## 4. Not in this change

- Argo/Buzz `report` → OAR failover
- Writing Cursor `CURSOR_API_KEY` for Buzz Grok
- Creating missing Argo/Codex installs
- Linux/Windows Argo paths (write only when the file exists)
- Live authenticated GUI / paid model requests (not claimed by smoke)
