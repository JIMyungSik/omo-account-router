# Using OAR with different ADEs (agents / IDEs)

**Languages:** [English](ades.md) · [한국어](ades.ko.md)

OAR is an **account layer**, not a model router.

| Layer | Who decides |
|-------|-------------|
| Which **model / provider** to call | The ADE (OMO, Claude Code, Codex, …) |
| Which **login / subscription account** is active for that provider | **OAR** (when the ADE reads a supported auth store) |

```text
ADE session  →  picks model (e.g. grok / claude / codex)
                    ↓
               needs credentials
                    ↓
OAR vault  →  activates one profile into the ADE’s auth file/slot
```

---

## Support matrix

| ADE | Popularity (2025–2026, rough) | OAR integration | What works today |
|-----|------------------------------|-----------------|------------------|
| **OMO** (`omo`) | Niche (Senpi/OMO stack) | **First-class** | Hot-switch, panel, usage, extension, auto |
| **Senpi** (`senpi`) | Niche (engine under OMO) | **First-class** | Same as OMO; also isolated `/login` temp dirs |
| **pi / omp** (pi-ai family) | Growing OSS CLI family | **Experimental** | Same `auth.json` shape if agent dir is pointed at OAR targets |
| **gjc** (gajae-code) | Niche fork | **Experimental** | If it uses a Senpi-like `auth.json`, set `OAR_AUTH_PATH` |
| **OpenAI Codex CLI** (`codex`) | High (OpenAI coding agent) | **Partial** | Usage % via OAuth; account switch via vault → needs `CODEX_HOME` / auth.json bridge |
| **Claude Code** (`claude`) | **Very high** (survey leader) | **Partial / planned** | Usage/switch not first-class yet; credentials live under `~/.claude` (different format) |
| **Cursor** | **Very high** (IDE) | **Out of band** | Own account UI; OAR does not control Cursor login |
| **GitHub Copilot** | **Very high** | **No** | VS Code/GitHub auth — not OAR’s auth.json model |
| **OpenCode** | High OSS interest (stars/MAU claims) | **Experimental** | Only if configured to shared Senpi-style auth |
| **Gemini CLI** | Rising (Google) | **No / TBD** | Separate Google auth |
| **Aider** | Established OSS | **No / TBD** | Env API keys / own config |
| **Orca** | Niche desktop multi-agent | **No (own multi-account)** | Orca keeps per-profile homes under Application Support — not `~/.omo/agent` |
| **Cline / Continue / Windsurf** | Popular IDE extensions | **No** | Each has its own secret store |

**Popularity sources (indicative, not a single “market share” number):**

- Developer surveys / tooling roundups often put **Claude Code**, **Cursor**, and **Copilot** at the top of day-to-day use ([Pragmatic Engineer – AI tooling 2026](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026), various “best AI coding agents 2026” lists).
- **OpenAI Codex CLI** is widely used in the OpenAI ecosystem.
- **OpenCode**, **Gemini CLI**, **Aider** show strong OSS/CLI traction on GitHub and community lists.
- **OMO / Senpi / pi / gjc / Orca** are important in specific communities but are not the global majority.

OAR’s **deepest** integration is the **Senpi/OMO auth.json hot-reload** path. Other ADEs need an **adapter** (path + credential format + reload behavior).

---

## First-class: OMO / Senpi

### Setup

```bash
npm install -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
# or: npm install -g oar-cli

oar doctor
oar daemon start
oar import-auth --all
bash "$(npm root -g)/oar-cli/scripts/install.sh" --skip-build   # optional LaunchAgent + extension
```

### Daily

```bash
oar panel --refresh
oar recommend --refresh
oar use xai sub
oar use openai-codex main
```

### Why it hot-swaps without restart

1. `omo` sets `SENPI_CODING_AGENT_DIR=~/.omo/agent`
2. Each model call re-reads `auth.json`
3. OAR atomically replaces one provider key in that file

### Second account login

Use **`senpi` + temp dir**, not `omo` (launcher forces `~/.omo/agent`):

```bash
oar guide second-account
```

---

## Experimental: pi / omp / gjc (Senpi-like agents)

These often share the **same credential file idea** (`auth.json` map of provider → oauth/api_key), but different home directories.

### 1) Find the agent’s auth file

```bash
# examples — adjust to your install
ls ~/.omo/agent/auth.json
ls ~/.senpi/agent/auth.json
ls ~/.pi/agent/auth.json
ls ~/.omp/agent/auth.json
ls ~/.gajae-code/agent/auth.json
```

### 2) Point OAR at it

```bash
# single target
export OAR_AUTH_PATH="$HOME/.pi/agent/auth.json"

# or write every known path OAR discovers
export OAR_ACTIVATE_ALL=1

oar daemon restart 2>/dev/null || (oar daemon stop; oar daemon start)
oar use xai sub
```

### 3) Check reload behavior

| Behavior | Result |
|----------|--------|
| ADE re-reads auth on every request | Hot-switch works like OMO |
| ADE caches auth at process start | Need **restart** after `oar use` (cold-switch) |

### 4) Extension / auto failover

The bundled `extensions/oar-senpi.js` is for **Senpi/OMO**.  
pi/gjc need their own hook, or you rely on **manual** `oar use` + usage/recommend only.

---

## Partial: OpenAI Codex CLI

| Feature | Status |
|---------|--------|
| `oar usage` / recommend for `openai-codex` profiles | Yes (ChatGPT OAuth usage) |
| Vault multiple Codex accounts | Yes (`oar import-auth openai-codex …`) |
| Hot-switch inside running `codex` TUI | **Depends** — Codex uses `~/.codex/auth.json` / `CODEX_HOME`, not OMO’s file by default |

### Practical recipes

**A. Usage + recommend only (safest)**  
Keep using Codex CLI as today; use OAR to monitor / decide which account to log in as.

```bash
oar recommend openai-codex --refresh
```

**B. Drive Codex home from OAR vault (advanced)**  
1. `oar use openai-codex sub` writes OMO/Senpi auth if that’s your `OAR_AUTH_PATH`  
2. To feed **Codex CLI**, either:
   - run Codex with a `CODEX_HOME` you sync from vault (custom script), or  
   - import/export between `~/.codex/auth.json` and OAR vault manually  

Full automatic Codex-home activate is a planned adapter, not first-class yet.

---

## Partial: Claude Code

Very widely used ([surveys / 2026 tooling writeups](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026)).

| Feature | Status |
|---------|--------|
| OAR first-class hot-switch | **Not yet** |
| Credential store | `~/.claude/` (not Senpi `auth.json`) |
| Multi-account community tools | e.g. claude-swap, TeamClaude, profile `CLAUDE_CONFIG_DIR` |

**What you can do with OAR today**

- Run OAR for **xai / openai-codex / openrouter** accounts used by OMO  
- For Claude Code multi-account, use Claude-specific switchers **or** wait for an OAR `adapter-claude`  

Do **not** expect `oar use anthropic …` to change Claude Code’s login until that adapter exists.

---

## Not integrated: Cursor, Copilot, Gemini CLI, Aider, IDE extensions

These keep **their own** login/secret UIs (editor settings, Google OAuth, `~/.aider`, etc.).

OAR can still help if:

1. You use **API keys** stored in a Senpi-compatible `auth.json` that some bridge reads, or  
2. You only want **usage dashboards** for providers OAR already probes (Codex/Grok) while coding elsewhere.

Otherwise: use each product’s native account switcher.

---

## Not integrated: Orca

Orca is a desktop multi-agent app with **its own** multi-account layout, e.g. under:

`~/Library/Application Support/orca/codex-accounts/...`

OAR’s default target is **`~/.omo/agent/auth.json`**.  
`oar use` does **not** switch Orca profiles.

| Goal | Tool |
|------|------|
| Orca internal profiles | Orca UI |
| OMO/Senpi accounts | OAR |
| Shared “brain” for both | Future adapter / manual export |

---

## Environment variables (all ADEs)

| Variable | Meaning |
|----------|---------|
| `OAR_HOME` | State/vault root (default `~/.oar`) |
| `OAR_SOCK` | Daemon socket |
| `OAR_AUTH_PATH` | Single auth.json to activate into |
| `OAR_ACTIVATE_ALL=1` | Activate into all discovered auth.json paths |

```bash
# example: OMO + senpi homes together
export OAR_ACTIVATE_ALL=1
oar use xai sub
```

---

## Feature availability by ADE class

| Feature | OMO/Senpi | pi/gjc (auth.json) | Codex CLI | Claude Code | Orca | Cursor/Copilot |
|---------|-----------|--------------------|-----------|-------------|------|----------------|
| `oar panel` / `usage` / `recommend` | Yes | Yes* | Yes* | Limited | Yes* (monitor only) | Monitor only if vault filled |
| Hot `oar use` | Yes | If reload | Partial | No | No | No |
| Extension auto-failover | Yes | No (need hook) | No | No | No | No |
| Isolated 2nd login guide | Yes (`senpi`) | Varies | Varies | Use Claude tools | Orca UI | Native UI |

\*Usage/recommend need credentials **in OAR vault**, not only in the other ADE.

---

## Recommended setups

### “I live in OMO”
Full OAR path — install, extension, `recommend`, auto (with compliance awareness).

### “I use Claude Code + Codex CLI + sometimes OMO”
- OAR: Codex + Grok accounts for OMO + usage tables  
- Claude Code: dedicated multi-account tool or profiles  
- Don’t expect one `oar use` to switch every ADE at once (unless `OAR_ACTIVATE_ALL` and shared auth format)

### “I use Orca”
Use Orca’s account system for Orca sessions.  
Use OAR for OMO/Senpi sessions. Treat them as separate.

### “I only want remaining %”
```bash
oar import-auth --all          # from wherever you can export auth.json
oar usage --refresh
oar recommend --refresh
```
No ADE hooks required.

---

## Roadmap (adapters)

Priority inspired by popularity + technical fit:

1. **OMO/Senpi** — done (first-class)  
2. **Codex CLI `CODEX_HOME` activate** — high demand, OAuth already in OAR  
3. **Claude Code profile / config-dir adapter** — highest global popularity, different store  
4. **pi/omp/gjc auth.json detect** — low effort if paths standardize  
5. **Orca profile bridge** — high effort, separate product model  

---

## Quick diagnosis

```bash
oar doctor
echo "OAR_AUTH_PATH=$OAR_AUTH_PATH"
ls -la ~/.omo/agent/auth.json ~/.senpi/agent/auth.json ~/.codex/auth.json 2>/dev/null
```

If `oar use` succeeds but the ADE still uses the old account:

1. Confirm the ADE reads the same file OAR wrote (`OAR_AUTH_PATH`)  
2. Restart the ADE (cold-switch)  
3. Check you didn’t only update OMO while using Claude/Orca/Cursor  

---

## See also

- [README.md](../README.md) — install & commands  
- [compliance.md](compliance.md) — provider terms notes  
- `oar guide second-account` — multi-login for Senpi-family  
