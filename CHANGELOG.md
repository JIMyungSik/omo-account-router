# Changelog

## 0.3.0 — 2026-09-27

### Added
- **Account-first/model-second failover:** a verified-positive same-provider
  xAI profile retries the same Grok model before Senpi advances the native
  fallback chain.
- **`grok-astra` named preset:** `/model-preset list|use|status|off` compiles
  `xai/grok-4.5 → GPT-6 Astra → DeepSeek V4.1 Flash` into
  `retry.fallbackChains`.
- **Proactive quota polling:** the daemon refreshes remote quota every 60
  seconds and activates the first positive account in the user's configured
  order.
- **Runtime preset diagnostics:** status reports model availability,
  configured authentication, and fallback eligibility for every target.

### Fixed
- Treat xAI's “run out of credits / need a Grok subscription” 403 wording as
  billing so eligible exhaustion can reach native model fallback.
- Stop model fallback for auth, prompt, tool, local, invalid-argument,
  model-not-found, refusal, and unknown failures.
- Ship the Senpi extension as one ESM bundle so helper files are not discovered
  as standalone extensions and symlink-relative imports cannot break.

### Compatibility
- Requires a Senpi build containing
  [`before_retry_fallback`](https://github.com/code-yeongyu/senpi/pull/2185)
  for account-first ordering.
- OAR CLI/daemon/vault remain tested on macOS, Ubuntu, and Windows; the macOS
  LaunchAgent installer remains macOS-only.

## 0.2.0 — 2026-09-19

### Added
- **Subscription optimizer (0.2.0-a/b):**
  - `oar subscriptions set|list|remove` — store monthly plan costs in `subscriptions.json`
  - `oar subscriptions audit [--json] [--refresh]` — join usage + eligibility + configured
    costs; suggest keep / demote / cancel candidate / fix first with potential savings
- **AUTH stale hints (P1):** `oar status` NOTE column warns when vault token expired or
  last check is older than 7 days, with `oar test … --live` remediation hint.

## 0.1.10 — 2026-09-19

### Fixed
- **CLI flag coverage:** `use`, `test`, and `import-auth` now reject unknown flags
  (prevents silent `--bogus` imports).
- **`report` transient failures:** `NETWORK_ERROR`, `BAD_REQUEST`, etc. record reason
  without altering routing eligibility.

### Added
- **`oar recommend --json`** — structured ranking output with `topPick`.
- **`oar doctor` Codex remediation** — when cached usage shows HTTP 401/403, prints
  re-auth steps.

## 0.1.9 — 2026-09-19

### Fixed
- **Unicode mojibake (P0):** `bin/oar-wrapper.sh` now prefers `node dist/cli.js` over
  `bun dist/cli.js` so status/panel punctuation renders as UTF-8.
- **`oar report` validation:** unknown accounts and invalid RESULT values (e.g. `FOO`)
  now fail with exit 1 instead of silently accepting.
- **`oar remove` / `oar logout`:** nonexistent profiles return `unknown account` exit 1.
- **Unknown CLI flags:** `panel`, `status`, `usage`, and `recommend` reject unrecognized
  flags instead of ignoring them.
- **`usage` / `recommend` with daemon down:** stderr warning when falling back to
  cached/local data without a live daemon sync.

### Added
- `oar --version` / `oar -V` and `oar help`.
- Shorter unknown-subcommand error (`try: oar -h`).

## 0.1.8 — 2026-09-19

### Fixed
- **Hidden multi-login accounts (`--account`)**: xAI (and any provider using the
  Senpi auth format) can store several logins — e.g. a Google login and a
  Sign-in-with-Apple login for the same email — inside ONE auth slot as an
  `accounts[]` array. OAR always imported/used only the primary (top-level)
  token, so a live secondary login looked exhausted: `oar usage` reported 0%
  and `oar use` refused to switch even though the other account had quota.

  `oar import-auth <provider> <profile> --account <n|name>` now selects a
  specific login from `accounts[]` (1-based index or `name` field). Unknown
  selections fail with the available account list.

  ```bash
  oar import-auth xai apple --account 3        # by index
  oar import-auth xai apple --account login-3  # by name
  oar usage xai apple --refresh && oar use xai apple
  ```

- Regression tests: `tests/import-account-select.test.ts` (5 cases: default
  primary, index select, name select, unknown-account error listing, missing
  provider).
