# Contributing to OAR

OAR (`oar-cli`) is a local multi-account router. It copies credentials into live auth slots. Treat every credential as secret.

## Workflow

`main` does not accept a direct push, including from administrators. Open a pull request. The `pr-gate` workflow runs unit tests, integration tests, and the style check. If all three pass, the workflow comments with the result, squash-merges a same-repo PR, and deletes its branch. If any fail, it requests changes and does not merge.

1. Branch from up-to-date `main`, or open a PR from a fork.
2. Keep the change small and limited to the behavior you are fixing.
3. Run `bun test` and `node scripts/check-style.mjs` locally. Do not delete or skip a failing test to get green.
4. Open a pull request against `main`. Say what changed and how you verified it.
5. Wait for `unit`, `integration`, and `style`. A failure is a change request. Push a fix to the same branch.
6. Resolve every review conversation. Do not force-push or delete `main`.

Fork PRs are tested the same way, but they are not auto-merged. A maintainer merges them after the checks pass.

Merge commits and rebase merges are disabled. Squash merge is the repository standard.

Do not commit tokens, `auth.json`, vault files, or `.env`. Tests use fake credentials only.

## Coding style

Match the surrounding file. Do not restyle unrelated code.

- TypeScript under `src/`, tests under `tests/`, run with `bun test`.
- Runtime for published CLI is Node 22+. Dev scripts may use Bun.
- Prefer a named export. Do not add a new framework or validator for one call site.
- Provider ids are canonical after alias resolution. `openai`, `codex`, `chatgpt`, and `openai-codex` mean `chatgpt-subscription`. `grok` means `xai`. Add a new alias in `src/provider-alias.ts` and cover it with a test.
- Auth slot writes must preserve other providers. A Codex write updates `chatgpt-subscription` and an existing `openai-codex` key, and must not drop a different account that does not match.
- Never print access tokens, refresh tokens, or API keys. Errors may name a path and a provider, not a secret.
- A delete that fails must fail the command. Do not report success after a swallowed unlink or write error.
- Tests use a temp `OAR_HOME` and temp auth file. Do not point a test at `~/.oar` or `~/.omo`.

## Checks

```bash
bun install
bun test
bun run build
```

`bun run build` updates `dist/`, which the published `oar` command runs. Include that output when the CLI or daemon behavior changes.
