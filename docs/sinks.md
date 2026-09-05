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
        └─ Codex CLI  $CODEX_HOME/auth.json      (openai-codex only)
                      default ~/.codex = Buzz Codex runtime
```

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Architecture | Sink writers on `activate` | Same command path as OMO hot-switch |
| Fail open | Sink errors do not roll back Senpi write | OMO must keep working if Argo/Buzz files are locked |
| Create files? | Never. Write only if the target already exists | Do not invent an Argo/Codex install |
| Disable | `OAR_SINKS=0`, `OAR_ARGO_SINK=0`, `OAR_CODEX_SINK=0` | Opt-out without uninstall |
| Auto failover | Unchanged (OMO extension only) | Argo/Buzz do not emit OAR `report` |
| Reload | Cold for Argo/Buzz if they cache at launch | Restart that app after `oar use` if the new account does not show |

## 1. Argo × xAI

**Observed (argo 0.1.54):**

- `~/Library/Application Support/com.beyondworks.argo/workspaces/.account-secrets-local.json`
- per-workspace `.secrets.json` (same `runners` shape)
- `runners.grok = { type: "oauth", value: "<json string>" }`
- value JSON: `{ access_token, refresh_token, expires_at }` (`expires_at` = ms epoch)
- `runners.codex.type = "host"` (host Codex login — not this sink)
- `runners.glm.type = "apikey"` (untouched)

**Map from OAR `xai` oauth credential:**

| Vault | Argo grok value |
|---|---|
| `access` | `access_token` |
| `refresh` | `refresh_token` |
| `expires` | `expires_at` |

Write rules:

- Provider must be `xai` and credential `type === "oauth"`.
- Keep sibling runners (`codex`, `glm`) and unknown keys.
- Replace `runners.grok` only when that key already exists.
- Atomic write, mode `0600`.
- Override path: `OAR_ARGO_SECRETS_PATH` (tests / non-default layout).

## 2. Buzz Codex × `CODEX_HOME`

Buzz Codex agents on this machine use `runtime: "codex"` / `agent_command: "codex-acp"` and do **not** set `CODEX_HOME`. They inherit the host CLI home: `~/.codex/auth.json`.

**Observed Codex CLI `auth.json`:**

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "...",
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "2026-09-05T00:00:00.000Z"
}
```

**Map from OAR `openai-codex` oauth credential:**

| Vault | Codex auth.json |
|---|---|
| `access` | `tokens.access_token` |
| `refresh` | `tokens.refresh_token` |
| `accountId` | `tokens.account_id` |
| — | `last_refresh` = now (ISO) |
| — | keep `auth_mode` if present, else `"chatgpt"` |
| — | keep `OPENAI_API_KEY` as-is |
| — | keep `tokens.id_token` only when access+refresh match the previous file |

If Buzz later sets `CODEX_HOME`, honor `CODEX_HOME` or `OAR_CODEX_HOME`.
Override file: `OAR_CODEX_AUTH_PATH`.

Buzz **Grok** agents are `runtime: "cursor"` (Cursor pool). Out of scope.

## 3. Not in this change

- Argo/Buzz `report` → OAR failover
- Writing Cursor `CURSOR_API_KEY` for Buzz Grok
- Creating missing Argo/Codex installs
- Linux/Windows Argo paths (write only when the file exists)
