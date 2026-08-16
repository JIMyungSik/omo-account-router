# OMO ↔ OAR auto accounts + Cursor provider

## What you get

1. **No daily `oar` commands** for account switching  
   The OMO extension (`oar-senpi.js`) on `session_start` runs `bootstrap-auto`:
   - every provider with **2+ vault profiles** → `mode=auto` + `autoFailover`
   - preferred profile is written into live `auth.json`
   - on AUTH_EXPIRED / AUTH_REVOKED / RATE_LIMIT / QUOTA the daemon failovers
     and activates the next profile for the **next** request

2. **Cursor as an OMO provider (bridge)**  
   Models under `cursor/*` talk to a local OpenAI-compatible bridge that shells
   out to `cursor-agent`. That burns the **Cursor Models pool** (Cursor Grok /
   Composer), not SuperGrok xAI OAuth.

## One-time setup

```bash
cd /Users/victor/_02_business/_03_program/omo-account-router
bun test && bun run build
bash scripts/bootstrap-omo-oar.sh
# restart OMO once
```

Import accounts once (still needs vault population):

```bash
oar import-auth --all          # or per-profile after /login
oar bootstrap-auto             # optional; also runs on every OMO session_start
```

## Day-to-day

| Action | Who |
|--------|-----|
| Pick eligible xAI/Codex/Claude profile | OAR daemon via extension (automatic) |
| Failover when quota/auth dies | Automatic (next request) |
| Manual override | `/account use xai sub` inside OMO, or `oar use` |
| Use Cursor Grok pool | OMO model `cursor/cursor-grok-4.6-high` (bridge must be up) |

## Cursor limits (honest)

- Official Cursor API is **Cloud Agents**, not chat-completions.
- The bridge is a **best-effort** local adapter (`scripts/cursor-bridge.mjs`).
- OMO tool-calling parity is incomplete: cursor-agent runs **its own** tools.
- Prefer: OMO native providers (xai/…) for full tool loops; Cursor model or
  `cursor_delegation` when you want to spend Cursor included usage.

## Health

```bash
oar doctor
curl -s http://127.0.0.1:18765/health
# in OMO: /account status   /cursor-bridge
```

## OMO source

Upstream clone (reference):  
`/Users/victor/_02_business/_03_program/oh-my-openagent`  
Integration lives in **this** repo (OAR) as extensions + bootstrap — no OMO
fork required for auto-switch or the Cursor bridge.
