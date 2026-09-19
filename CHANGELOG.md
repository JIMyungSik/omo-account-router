# Changelog

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
