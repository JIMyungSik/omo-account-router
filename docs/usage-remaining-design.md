# xAI / Codex remaining-usage design (OAR)

Status: research complete · implementation not started  
Date: 2026-08-16  
Scope: what OAR can honestly show as “usage / remaining %” for **xAI** and **openai-codex**.

## Executive answer

| Provider | Official live “remaining %” API? | What OAR can do without gray-area scraping |
|----------|----------------------------------|--------------------------------------------|
| **xAI (Grok OAuth → `api.x.ai`)** | **No** documented remaining-quota endpoint; console shows tier RPS/TPM | **Passive**: sum per-response tokens + `cost_in_usd_ticks`; mark 429 windows. **Not** a true residual % |
| **openai-codex (ChatGPT OAuth → `chatgpt.com/backend-api`)** | **No** public stable API for residual %; official UI is Codex Usage page / CLI `/status` | **Passive**: classify usage-limit errors; surface cooldown. **Do not** reverse-engineer private backend usage routes |

**True remaining % in `oar panel` is not available today for either path under documented, ToS-safe APIs.**

---

## Auth paths OMO actually uses

### xAI
- Login: device-code OAuth (`auth.x.ai`) — same family as senpi `pi-ai` xAI OAuth.
- Runtime base URL: `https://api.x.ai/v1` (senpi provider).
- Credential in vault: `{ type: "oauth", access, refresh, expires }`.

This is **not** the same as an xAI **Management API** key (`management-api.x.ai`). Management API can manage keys/limits config; it is **not** a live “how much quota left on this consumer session” probe, and requires a separate management credential OAR does not store today.

### openai-codex
- Login: ChatGPT OAuth (browser / device code) — Plus/Pro style subscription access.
- Runtime base URL: `https://chatgpt.com/backend-api` (+ `/codex/responses`).
- Credential: OAuth access/refresh + `accountId` (from JWT claim `chatgpt_account_id`).

This is **subscription Codex**, not `platform.openai.com` API-key billing. API-key rate-limit headers (`x-ratelimit-remaining-*`) apply to the **API key** product, not to ChatGPT OAuth Codex pools.

---

## xAI — official surface (sources)

Primary docs:
- https://docs.x.ai/developers/rate-limits
- https://docs.x.ai/developers/cost-tracking
- Console rate limits: https://console.x.ai/team/default/rate-limits

### What exists
1. **Per-model RPS + TPM caps** by spend tier (Tier 0–4). View in Console.
2. **HTTP 429** when over limit. Docs recommend exponential backoff. **No** documented requirement for `Retry-After` or `x-ratelimit-remaining-*` headers.
3. **Per-response `usage` object**, including:
   - token fields (`input_tokens` / `output_tokens` / `total_tokens`, etc.)
   - **`cost_in_usd_ticks`** with `cost_usd = ticks / 10_000_000_000`
4. Streaming: cost/usage on final chunk when `stream_options.include_usage` (OpenAI-compatible path).

### What does **not** exist (documented)
- Endpoint: “GET remaining TPM/RPS % for this token”
- Guaranteed response headers for remaining quota
- Consumer OAuth “plan percent left this 5h window” (console tier is **API spend tier**, not a simple % bar)

### Implication for OAR
| Metric | Feasible? | How |
|--------|-----------|-----|
| Tokens used (window) | Yes | Extension/daemon records `usage` from responses |
| $ spent (window) | Yes | Sum `cost_in_usd_ticks` |
| Last 429 / cooldown | Yes | Existing `RATE_LIMITED` + `until` |
| Remaining RPS/TPM % | **No (official)** | Would require undocumented headers or console scrape |
| Prepaid credit balance % | **Unknown / not in consumer OAuth docs** | Console billing UI; not in OAR token path |

**Best honest xAI panel fields:**  
`spent_usd_24h`, `tokens_24h`, `ok`, `rl`, `last_rl_at`, `status` — label remaining as `n/a`.

---

## openai-codex — official surface (sources)

Primary references:
- Codex auth overview: https://learn.chatgpt.com/docs/auth  
- Codex pricing / plan limits: https://chatgpt.com/codex/pricing/  
- Usage UI (human): https://chatgpt.com/codex/settings/usage  
- In official Codex CLI: `/status` shows provider-reported remaining limits (product feature of Codex CLI, not a public OAR API)

Senpi runtime facts (installed engine):
- Provider id `openai-codex`, base `https://chatgpt.com/backend-api`
- Errors matching `GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage_limit_reached|…` treated as terminal usage limits
- `onResponse` already exposes `{ status, headers }` to callers — useful for **passive** capture if headers ever include useful fields
- WebSocket session cache is account/session keyed (hot-switch caveat already documented)

### What exists for humans
- Web **Usage** page with rolling windows (e.g. 5h / weekly) and percentages
- Codex CLI `/status`
- Hard stop messages when pool exhausted

### What OAR must **not** do
- Document or implement **undocumented** `chatgpt.com/backend-api/...usage...` probes  
- Scrape the usage webpage with session cookies  
- Pretend API-key `x-ratelimit-remaining-*` applies to ChatGPT OAuth Codex

### Implication for OAR
| Metric | Feasible? | How |
|--------|-----------|-----|
| Hit usage limit (hard) | Yes | Classify response/error → `QUOTA_EXHAUSTED` / cooldown |
| Remaining % (5h/week) | **Not via public API** | Link out to Usage page; optional future if OpenAI publishes an API |
| Tokens/$ on Codex sub | Partial / model-dependent | Only if response stream exposes usage OAR can see without private routes |
| API-key remaining headers | Only if user stores **API key** codex/openai credential (different product) | Out of current OAuth vault shape |

**Best honest Codex panel fields:**  
`status`, `last_limit_error`, `cooldown_until`, `ok/rl/quota` counts, `dashboard: chatgpt.com/codex/settings/usage` — remaining `%` = `n/a (see dashboard)`.

---

## Recommended OAR architecture (phased)

### Phase 0 — already shipped
- `oar panel`: selection ★, mode/auto, local event OK/RL/QUOTA/auth counts
- Failover on classified limit errors when `oar auto on`

### Phase 1 — Passive usage ledger (safe, high value)  ← **recommended next**
Goal: “how hard did this account work / did it hit limits?” not fake %.

1. Extend extension `after_provider_response` (and/or senpi hooks) to report optional:
   ```ts
   {
     result: "SUCCESS" | "RATE_LIMITED" | ...,
     usage?: {
       inputTokens?: number;
       outputTokens?: number;
       totalTokens?: number;
       costUsdTicks?: number; // xAI
       raw?: Record<string, number>; // bounded, no secrets
     },
     headers?: {
       retryAfterSec?: number;
       // only well-known public header names if present
       rateLimitRemaining?: number;
       rateLimitResetSec?: number;
     }
   }
   ```
2. Daemon persists rolling aggregates per `provider/profile` in state or side file `~/.oar/usage.json` (0600).
3. `oar panel` columns:
   - `tok` (24h), `$` (24h, xAI), `rl`, `quota`, `reset` / `until`
   - `rem%` column stays `—` unless a **documented** remaining value was observed in headers/body

Acceptance:
- No new network calls just to paint the panel
- No secrets in events
- Works offline for display of stored aggregates

### Phase 2 — Derived “pressure” score (optional, clearly labeled)
Not a residual % of provider plan. Example:

`pressure = f(recent_rl_rate, recent_quota_events, tokens_per_hour vs user-configured budget)`

User can set soft budgets:
```bash
oar budget set xai main --usd-per-day 5
oar budget set openai-codex sub --errors-per-hour 3
```
Panel shows `budget_used%` against **user budget**, not ChatGPT/xAI plan %.

This is honest and useful for multi-account ops.

### Phase 3 — Explicit probe commands (only documented)
```bash
oar usage xai main          # dump stored ledger + last probe
oar usage openai-codex sub
```
- **xAI:** optional tiny authenticated call only if we later confirm a documented usage endpoint; until then, **probe = “replay last known usage + healthCheck”**, not a fake remaining fetch.
- **Codex:** print deep link + last classified limit event; do **not** hit private usage routes.

### Phase 4 — Out of scope / reject
- Headless login to console.x.ai / chatgpt.com to scrape %
- Bundling reverse-engineered backend-api usage schemas
- Inventing remaining % from token counts without a known denominator

---

## Panel UX proposal (after Phase 1)

```text
PROV          PROFILE  ★  STATUS     TOK24H   $24H    RL  QUOTA  REM%   RESET
xai           main        AVAILABLE  1.2M     0.84    0   0      —      —
xai           sub      ★  AVAILABLE  80k      0.05    2   0      —      14:02Z
openai-codex  main     ★  ACTIVE     —        —       0   1      —      see UI
openai-codex  sub         AVAILABLE  —        —       0   0      —      —
```

Footer always:
> `REM%` is only shown when the provider returned a documented remaining signal.  
> Codex plan bars: https://chatgpt.com/codex/settings/usage  
> xAI API limits: https://console.x.ai/team/default/rate-limits  

Menubar (`oar panel --xbar`): same numbers; click still `oar use`.

---

## Multi-account ops guidance (today)

Until Phase 1–2 land:

1. Rely on **failover** (`oar auto <provider> on`) + `QUOTA_EXHAUSTED` / `RATE_LIMITED` classification.  
2. Use `oar panel` for **which account is live** and **how often limits fired**.  
3. For true plan bars:
   - Codex → browser Usage page (per account after `oar use` + browser session of that account), or Codex CLI `/status` under that login.
   - xAI API → Console Rate Limits / billing for the API team tied to that credential.

---

## Decision record

| Decision | Choice | Why |
|----------|--------|-----|
| Show fake remaining % | **No** | No denominator from official APIs for OAuth paths |
| Scrape private Codex usage API | **No** | Unstable + policy / ToS risk |
| Capture xAI `cost_in_usd_ticks` | **Yes (Phase 1)** | Documented, exact, per request |
| User-defined budgets as % | **Yes (Phase 2)** | Honest operational metric |
| supportsUsageQuery() | Keep `false` until a documented remaining signal exists; add `supportsUsageLedger(): true` instead | Avoid lying to callers |

---

## Suggested implementation order

1. **Phase 1 ledger** (extension report enrichment + `usage.json` + panel columns)  
2. **Phase 2 user budgets** (`budget_used%`)  
3. Revisit Codex/xAI only if they publish a stable remaining endpoint  

Estimate for Phase 1: small (extension + daemon store + panel) — no provider reverse engineering.

## Implementation status (2026-08-16)

- Shipped: `oar usage`, `oar panel` remote columns via `src/usage/*`.
- Codex: `GET chatgpt.com/backend-api/wham/usage` with vault OAuth (5h when secondary/short window present; weekly primary common).
- xAI: `GET cli-chat-proxy.grok.com/v1/billing?format=credits` with vault OAuth access (Grok subscription 