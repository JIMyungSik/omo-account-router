# Compliance and provider terms

> Maintainer's good-faith notes — **not legal advice.**  
> Providers interpret and change their own Terms. Read the current docs and decide yourself.
>
> - OpenAI: https://openai.com/policies/row-terms-of-use/
> - Anthropic: https://www.anthropic.com/legal/aup · https://www.anthropic.com/legal/consumer-terms
> - xAI: https://x.ai/legal/terms-of-service · https://x.ai/legal/acceptable-use-policy

## What OAR is

OAR (**OMO Account Router**) is a **local** tool on **your machine**.

- It stores **credentials you already control** under `~/.oar/vault` (mode `0600`).
- It activates one profile into agent `auth.json` slots (default `~/.omo/agent/auth.json`).
- It is **not** a hosted proxy, not a shared login service, and does not sell access.

## Your responsibilities

1. Use only accounts **you legitimately own**.
2. Do **not** share vault credentials or the OAR daemon with other people.
3. Prefer official clients / APIs your provider allows.
4. Remote usage % probes (Codex product usage endpoint, Grok billing proxy) are **best-effort**, may break, and may be restricted by provider terms — use at your own risk.
5. **`oar auto` (auto-failover)** may be treated by providers as circumventing rate limits or usage restrictions. It is **off by default**. Enable only if you accept that risk.

## Multi-account switching

Manual switching between profiles you own (for example work vs personal) is a common local workflow.

**Automated rotation to pool quota across multiple paid subscriptions is not clearly blessed by providers.** Weigh it against current Terms before enabling auto mode.

## No warranty

MIT license. We do not warrant that any particular use complies with third-party Terms. Account suspension risk is yours.
