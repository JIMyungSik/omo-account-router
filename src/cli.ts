#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAuthStaleHints } from "./auth-stale.ts";
import { OarClient } from "./client.ts";
import { positionalArgs, rejectUnknownFlags } from "./cli-flags.ts";
import { isCodexProvider, isXaiProvider } from "./provider-alias.ts";
import { importAllFromAuthJson, importSelectionUsed, readCredentialFromAuthJson } from "./import-all.ts";
import { readImportAccountSetting, writeImportAccountSetting } from "./import-pref.ts";
import { parseReportResult } from "./report-results.ts";
import { formatSinkResultLines } from "./sinks/index.ts";
import type { SinkApplyResult } from "./sinks/types.ts";
import {
  defaultOarRoot,
  discoverAuthJsonFiles,
  oarSocketPath,
  resolveActiveAuthPaths,
} from "./paths.ts";
import type { OarRequest } from "./protocol.ts";
import { findSenpiInstall } from "./senpi-install.ts";
import { buildPanelSnapshot, formatPanelText, formatPanelXbar, type StatusPayload } from "./panel.ts";
import { buildStatusView, formatStatusText, statusViewToJson, wantStatusColor } from "./status-format.ts";
import { OarStore } from "./store.ts";
import { describeLiveAuth, formatWho } from "./who.ts";
import { fetchRemoteUsage, fetchRemoteUsageForAccounts } from "./usage/fetch.ts";
import { formatUsageTable } from "./usage/format.ts";
import { buildSubscriptionAudit } from "./subscriptions/audit.ts";
import { auditToJson, formatAuditText, formatSubscriptionsList } from "./subscriptions/format.ts";
import { SubscriptionsStore } from "./subscriptions/store.ts";
import { buildRecommendations, formatRecommendTable } from "./usage/recommend.ts";
import type { AccountRecord } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  const pkgPath = join(__dirname, "..", "package.json");
  if (!existsSync(pkgPath)) return "unknown";
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function usage(): string {
  return `oar — OMO Account Router

Local multi-account hot-switch for OMO/Senpi. OAR stores credentials in a vault,
copies the active profile into live auth.json slot(s), and tracks routing state.
OAR routes and copies credentials; it does NOT automate OAuth login and does NOT
revoke provider refresh tokens.

Tip: run \`oar\` with no args for status and freshly fetched remote usage.

STATUS TABLE (oar / oar status)
  AUTH     Local/vault metadata from import or last check (valid|expired|revoked|unknown).
           Can stay "valid" after the live access token expires until test/usage updates it.
  STATUS   Routing eligibility in the daemon (AVAILABLE, ACTIVE, QUOTA_EXHAUSTED, …).
  ACTIVE   * marks the profile selected for that provider (target of the live auth slot).
  MODE     Provider policy: manual pick or auto failover.

  Separate from the status table:
  - \`oar usage\` OK column = latest remote usage API request succeeded (yes/no), not AUTH.
  - Routing STATUS and usage OK can disagree (e.g. AUTH valid but usage HTTP 401).

COMMANDS

  oar
      Quick status snapshot and freshly fetched remote usage when the daemon is up.
      On daemon failure, prints this help plus a start hint.

  oar status [--json]
      Markdown table: * PROVIDER PROFILE AUTH STATUS MODE AUTO NOTE.
      Header counts accounts / active / problematic. No remote usage fetch.
      --json  Structured rows + summary (exit 0).

  oar who
      Which vault profile is actually in each live auth.json. SLOT is set only
      when a Senpi accounts[] entry holds that same token. The footer @login-N
      is a per-session label and can name a different slot.

  oar accounts [provider]
      JSON list of vault accounts; optional filter by provider id.

  oar provider list
      One provider id per line from registered accounts.

  oar add <provider> <profile>
      Register a named profile slot (no credential yet).

  oar remove <provider> <profile>
      Delete that profile from daemon state and its vault credential.
      oar remove * deletes every vault account. Clears preferred if it
      pointed here. If the live auth.json slot is this same account, that
      provider key is removed. A different live account and subscription
      records stay.

  oar use <provider> <profile> [--force]
      Refreshes expired Codex/xAI OAuth in the vault without activating it,
      then checks remote usage and syncs quota state before switching.
      Refuses switch at 0% remaining unless --force. No OMO restart needed.
      Prints each sink id/status/path/detail (no credentials).

  oar auto <provider> on|off
      Enable/disable automatic failover to another eligible profile on failures.

  oar bootstrap-auto
      One-shot: for every provider with 2+ vault profiles, set mode=auto +
      autoFailover, and ensureActivated the preferred profile. OMO extension
      also runs this on session_start so daily use needs no manual oar.

  oar import-auth <provider> <profile> [--from <auth.json>] [--account <n|name>]
      Copy one provider credential from Senpi auth.json (default ~/.omo/agent/auth.json)
      into the OAR vault. openai, codex, chatgpt, and openai-codex all mean
      chatgpt-subscription. grok means xai. For chatgpt-subscription, --from may also be a native Codex
      auth.json (tokens.id_token + account_id; expiry from access-token JWT exp).
      When the provider slot carries a multi-login accounts[] array, --account
      selects one by 1-based index, name, latest, or primary. The default is
      latest (highest login-N). Pass --account or a third argument to override.
      Secrets stay in the vault; nothing is printed.

  oar import-auth --all [--from <auth.json>] [--profile <name>] [--force]
      Import every provider found in auth.json under one profile name (default main).
      Skips existing entries unless --force.

  oar login <provider> <profile>
      Print safe TUI login instructions only. OAuth stays in OMO/Senpi (/login);
      OAR never runs browser or device-code flows for you.

  oar logout <provider> <profile>
      Mark AUTH_REVOKED, remove vault entry. Does not restart Senpi.

  oar activate <provider> <profile>
      Low-level activate (JSON result); prefer \`oar use\` for hot-switch.

  oar test <provider> <profile> [--live]
      Probe stored credential. --live adds a best-effort remote call; does not
      change routing state.

  oar report <provider> <profile> <RESULT>
      Report runtime outcome to update STATUS (SUCCESS, AUTH_EXPIRED, AUTH_REVOKED,
      RATE_LIMITED, QUOTA_EXHAUSTED, NETWORK_ERROR, …).

  oar guide second-account
      Step-by-step for logging in a second account without clobbering the live slot.

  oar install [-- <install.sh args>]
      Run scripts/install.sh (symlink oar, daemon setup). Pass extra args after --.

  oar panel [--watch [sec]] [--json] [--xbar] [--hours N] [--refresh] [--no-remote]
      Rich dashboard: accounts, events, remote usage (openai-codex / xai).
      --watch [sec]  Refresh loop (default 2s). --json / --xbar for machine output.
      --hours N      Event window (default 24). --refresh  Bypass usage cache.
      --no-remote    Skip remote usage fetches.

  oar usage [provider] [profile] [--refresh]
      Always fetch and show remote quota for openai-codex and xai (5H/WK/Grok %).
      OK = request ok. Omit args to list all supported accounts.

  oar recommend [--refresh] [--json] [provider...]
      Rank profiles by eligibility + remote remaining %. Optional provider filter.
      --refresh  Fetch fresh usage (default). Daemon must be running for full sync.
      --json     Structured rows + topPick (machine output).

  oar subscriptions list
      Show configured monthly plan costs (subscriptions.json under OAR_HOME).

  oar subscriptions set <provider> <profile> --monthly-usd <n> [--plan "label"]
      Record monthly subscription cost for a vault profile.

  oar subscriptions remove <provider> <profile>
      Remove a configured plan cost.

  oar subscriptions audit [--json] [--refresh]
      Join vault usage + eligibility + configured costs; suggest keep/cancel/fix
      and estimate potential monthly savings (heuristic, not financial advice).

  oar doctor
      Local diagnostics: paths, Senpi install, auth.json discovery, daemon JSON.

  oar daemon start|stop|status
      Background unix-socket daemon (required for most commands).
      start   Detach daemon.  stop   SIGTERM.  status   JSON doctor payload.

ENVIRONMENT
  OAR_HOME   State root and vault (default ~/.oar)
  OAR_SOCK   Unix socket path (default under OAR_HOME)
  Codex sink path: OAR_CODEX_AUTH_PATH > OAR_CODEX_HOME > CODEX_HOME > ~/.codex
  Argo sink path:  OAR_ARGO_SECRETS_PATH or ~/Library/Application Support/com.beyondworks.argo/...
  Disable sinks:   OAR_SINKS=0 / OAR_ARGO_SINK=0 / OAR_CODEX_SINK=0 (restart daemon)

OAUTH TROUBLESHOOTING
  Symptoms: Senpi \`invalid_grant\`, refresh token revoked, HTTP 401/403 on usage or
  --live test, or AUTH/usage OK out of sync after long idle / reboot.

  v0.1.5+: resolve/ensureActivated pulls vault UP from a fresher live OAuth token
  (Senpi refresh) instead of overwriting live with a stale vault copy. Explicit
  \`oar use\` still pushes the preferred vault profile into the live slot.

  If refresh is already revoked at the provider, re-authenticate:

    1. oar login <provider> <profile>     # read the steps
    2. omo  →  /login  →  pick provider  →  complete browser OAuth
    3. oar import-auth <provider> <profile>
    4. oar use <provider> <profile>
    5. oar test <provider> <profile> --live
       oar usage <provider> <profile> --refresh

  Second account on same provider: oar guide second-account

EXAMPLES
  oar daemon start
  oar import-auth --all
  oar status
  oar use xai main
  oar panel --refresh
  oar usage --refresh
  oar recommend xai openai-codex
  oar auto xai on
`;
}

function secondAccountGuide(): string {
  return `Second account login guide (see also scripts/second-account.md)
두 번째 계정 로그인 가이드 (scripts/second-account.md 참고)

IMPORTANT: the \`omo\` launcher ALWAYS forces SENPI_CODING_AGENT_DIR=~/.omo/agent.
Do NOT use \`omo\` for an isolated second login — it will overwrite the live slot.
중요: \`omo\` 런처는 항상 SENPI_CODING_AGENT_DIR=~/.omo/agent 로 고정합니다.
두 번째 계정 격리 로그인에는 \`omo\` 를 쓰지 마세요 (라이브 슬롯을 덮어씁니다).

Method A — isolated senpi dir (recommended):
  1. oar import-auth <provider> main   # vault the current live account first
  2. export OAR_TMP_LOGIN_DIR="$(mktemp -d)/agent" && mkdir -p "$OAR_TMP_LOGIN_DIR"
  3. SENPI_CODING_AGENT_DIR="$OAR_TMP_LOGIN_DIR" senpi
     # inside TUI: /login  → pick provider → browser OAuth as SECOND account
  4. oar import-auth <provider> account-b --from "$OAR_TMP_LOGIN_DIR/auth.json"
  5. rm -rf "$(dirname "$OAR_TMP_LOGIN_DIR")"
  6. oar use <provider> account-b && oar status

Method B — temporary live swap (if senpi binary unavailable):
  1. oar import-auth <provider> main
  2. omo  →  /logout <provider>  →  /login <provider>  (second account)
  3. oar import-auth <provider> account-b
  4. oar use <provider> main     # restore first account into the live slot

No OMO restart needed after oar use — next request picks up the new slot.
oar use 이후 OMO 재시작 불필요 — 다음 요청부터 새 슬롯 사용.`;
}

async function withClient<T>(fn: (c: OarClient) => Promise<T>): Promise<T> {
  const client = new OarClient({
    socketPath: process.env.OAR_SOCK ?? oarSocketPath(),
    retries: 8,
  });
  try {
    return await fn(client);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ENOENT") || msg.includes("ECONNREFUSED")) {
      throw new Error(`OAR daemon unavailable (${process.env.OAR_SOCK ?? oarSocketPath()}). Run: oar daemon start`);
    }
    throw error;
  }
}

async function req(request: OarRequest) {
  return withClient((c) => c.request(request));
}

async function removeOne(provider: string, profile: string): Promise<void> {
  const res = await req({ protocol: 1, action: "remove", provider, profile });
  if (!res.ok) throw new Error(res.error);
  console.log(`removed ${provider}/${profile}`);
  const data = res.data as { authSlotsCleared?: string[]; authSlotsKept?: string[] };
  for (const path of data.authSlotsCleared ?? []) console.log(`auth slot cleared: ${path}`);
  for (const path of data.authSlotsKept ?? []) {
    console.log(`auth slot kept: ${path} (different account)`);
  }
}

async function warnIfDaemonDown(scope: string): Promise<boolean> {
  try {
    const res = await req({ protocol: 1, action: "ping" });
    return res.ok;
  } catch {
    console.error(
      `warning: OAR daemon unavailable — ${scope} uses cached/local vault data only (may be stale). Run: oar daemon start`,
    );
    return false;
  }
}

function printStatus(
  data: {
    accounts: AccountRecord[];
    resolvePreview: Array<{ provider: string; profile: string; status: string }>;
    authPaths: string[];
    state: { providers: Record<string, { mode: string; preferred?: string; autoFailover: boolean }> };
  },
  opts?: { json?: boolean },
) {
  const root = process.env.OAR_HOME ?? defaultOarRoot();
  const store = new OarStore({ rootDir: root });
  let view = buildStatusView(data);
  view = { ...view, rows: applyAuthStaleHints(view.rows, store) };
  if (opts?.json) {
    console.log(JSON.stringify(statusViewToJson(view), null, 2));
    return;
  }
  console.log(formatStatusText(view, { color: wantStatusColor() }));
}

async function daemonStart(): Promise<void> {
  const root = process.env.OAR_HOME ?? defaultOarRoot();
  const sock = process.env.OAR_SOCK ?? oarSocketPath(root);
  if (existsSync(sock)) {
    try {
      const client = new OarClient({ socketPath: sock });
      const pong = await client.request({ protocol: 1, action: "ping" });
      if (pong.ok) {
        console.log(`oar-daemon already running at ${sock}`);
        return;
      }
    } catch {
      // stale socket
    }
  }

  const daemonTs = join(__dirname, "daemon-main.ts");
  const daemonJs = join(__dirname, "daemon-main.js");
  const daemonEntry = existsSync(daemonTs) ? daemonTs : daemonJs;

  // Prefer current runtime (node or bun). Fall back to bun on PATH for .ts dev entry.
  const runtimeBin =
    typeof process.execPath === "string" && process.execPath.length > 0
      ? process.execPath
      : "node";
  const useBunForTs = daemonEntry.endsWith(".ts") && !runtimeBin.includes("bun");
  const spawnBin = useBunForTs ? "bun" : runtimeBin;
  const spawnArgs = useBunForTs ? [daemonEntry] : [daemonEntry];

  const child = spawn(spawnBin, spawnArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OAR_HOME: root, OAR_SOCK: sock },
  });
  child.unref();

  const ready = new OarClient({ socketPath: sock, retries: 20, timeoutMs: 500 });
  try {
    const pong = await ready.request({ protocol: 1, action: "ping" });
    if (pong.ok) {
      console.log(`oar-daemon started at ${sock}`);
      return;
    }
  } catch {
    // fall through
  }
  throw new Error("oar-daemon failed to become ready");
}

async function daemonStop(): Promise<void> {
  const sock = process.env.OAR_SOCK ?? oarSocketPath();
  const pidPath = `${sock}.pid`;
  if (!existsSync(pidPath)) {
    console.log("oar-daemon not running (no pid file)");
    return;
  }
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isFinite(pid)) throw new Error("invalid pid file");
  try {
    process.kill(pid, "SIGTERM");
    console.log(`sent SIGTERM to oar-daemon pid ${pid}`);
  } catch (error) {
    console.log(`could not signal pid ${pid}: ${error instanceof Error ? error.message : error}`);
  }
}

async function daemonStatus(): Promise<void> {
  try {
    const res = await req({ protocol: 1, action: "doctor" });
    console.log(JSON.stringify(res, null, 2));
  } catch (error) {
    console.log(`oar-daemon down: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

function suggestAccounts(provider?: string): string {
  try {
    // best-effort; may fail if daemon down
  } catch {
    /* ignore */
  }
  return provider
    ? `Try: oar accounts ${provider}   or   oar import-auth ${provider} <profile>`
    : `Try: oar accounts   or   oar import-auth --all`;
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === "-h" || cmd === "--help") {
    console.log(usage());
    return;
  }
  if (cmd === "--version" || cmd === "-V") {
    console.log(readPackageVersion());
    return;
  }
  if (cmd === "help") {
    console.log(usage());
    return;
  }
  // Bare \`oar\` → friendly snapshot (not a wall of help).
  if (!cmd) {
    try {
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok) throw new Error(res.error);
      const data = res.data as Parameters<typeof printStatus>[0];
      printStatus(data);
      const root = process.env.OAR_HOME ?? defaultOarRoot();
      const store = new OarStore({ rootDir: root });
      const targets = data.accounts
        .filter((account) => isCodexProvider(account.provider) || isXaiProvider(account.provider))
        .map((account) => ({ provider: account.provider, profile: account.profile }));
      if (targets.length > 0) {
        const rows = await fetchRemoteUsageForAccounts(store, targets, { root, force: true });
        console.log("");
        console.log(formatUsageTable(rows));
      }
    } catch (error) {
      console.log(usage());
      console.error(`\n(daemon tip: ${error instanceof Error ? error.message : error})`);
      console.error("Start with: oar daemon start");
      process.exitCode = 1;
    }
    return;
  }

  switch (cmd) {
    case "status": {
      rejectUnknownFlags(rest, new Set(["--json"]));
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok) throw new Error(res.error);
      printStatus(res.data as Parameters<typeof printStatus>[0], { json: rest.includes("--json") });
      return;
    }
    case "who": {
      const root = process.env.OAR_HOME ?? defaultOarRoot();
      const store = new OarStore({ rootDir: root });
      const rows = describeLiveAuth(resolveActiveAuthPaths(), store.listAccounts(), (provider, profile) =>
        store.getVaultCredential(provider, profile),
      );
      console.log(formatWho(rows));
      return;
    }
    case "accounts": {
      const res = await req({ protocol: 1, action: "accounts", provider: rest[0] });
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      return;
    }
    case "provider": {
      if (rest[0] !== "list") throw new Error("usage: oar provider list");
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok) throw new Error(res.error);
      const accounts = (res.data as { accounts: AccountRecord[] }).accounts;
      const providers = [...new Set(accounts.map((a) => a.provider))];
      console.log(providers.join("\n") || "(no providers)");
      return;
    }
    case "add": {
      const [provider, profile] = rest;
      if (!provider || !profile) throw new Error("usage: oar add <provider> <profile>");
      const res = await req({ protocol: 1, action: "add", provider, profile });
      if (!res.ok) throw new Error(res.error);
      console.log(`added ${provider}/${profile}`);
      return;
    }
    case "remove": {
      if (rest[0] === "*") {
        const listed = await req({ protocol: 1, action: "accounts" });
        if (!listed.ok) throw new Error(listed.error);
        const accounts = listed.data as Array<{ provider: string; profile: string }>;
        if (accounts.length === 0) {
          console.log("removed 0 accounts");
          return;
        }
        for (const account of accounts) {
          await removeOne(account.provider, account.profile);
        }
        console.log(`removed ${accounts.length} accounts`);
        return;
      }
      const [provider, profile] = rest;
      if (!provider || !profile) throw new Error("usage: oar remove <provider> <profile>\n   or: oar remove *");
      await removeOne(provider, profile);
      return;
    }
    case "use": {
      rejectUnknownFlags(rest, new Set(["--force"]));
      const force = rest.includes("--force");
      const [provider, profile] = positionalArgs(rest);
      if (!provider || !profile) {
        throw new Error("usage: oar use <provider> <profile> [--force]\n" + suggestAccounts());
      }

      // Refresh usage when possible; block 0% unless --force (even if auto is on).
      const root = process.env.OAR_HOME ?? defaultOarRoot();
      const store = new OarStore({ rootDir: root });
      const credential = store.getVaultCredential(provider, profile);
      if (
        (isCodexProvider(provider) || isXaiProvider(provider)) &&
        credential?.type === "oauth" &&
        Date.now() + 5 * 60 * 1000 >= credential.expires
      ) {
        const refreshed = await req({
          protocol: 1,
          action: "refresh",
          provider,
          profile,
          activate: false,
        });
        if (!refreshed.ok) {
          throw new Error(
            `REFUSED: could not refresh ${provider}/${profile} before checking quota: ${refreshed.error}`,
          );
        }
      }
      try {
        const u = await fetchRemoteUsage(store, provider, profile, {
          root,
          force: true,
          maxAgeMs: 0,
        });
        if (u.ok) {
          const w = u.windows.find((x) => x.remainingPercent != null) ?? u.windows[0];
          if (w?.remainingPercent != null && (w.remainingPercent <= 0 || w.limitReached)) {
            console.error(
              `WARNING: ${provider}/${profile} remote quota is exhausted (${w.remainingPercent}% remaining, ${w.label ?? w.kind}).`,
            );
            if (w.resetsAt) console.error(`  resets ~ ${w.resetsAt}`);
            // mark daemon exhausted
            try {
              await req({
                protocol: 1,
                action: "report",
                provider,
                account: profile,
                result: "QUOTA_EXHAUSTED",
                detail: `remote_usage_${w.label ?? w.kind}_0`,
              });
            } catch {
              /* ignore */
            }
            if (!force) {
              throw new Error(
                `REFUSED: not switching to ${provider}/${profile}; remote quota is exhausted ` +
                  `(${w.remainingPercent}% remaining). ` +
                  `Auto failover will also skip it. Use another profile, or --force to override.`,
              );
            }
            console.error("  --force set: switching anyway.");
          } else if (w?.remainingPercent != null) {
            try {
              const reported = await req({
                protocol: 1,
                action: "report",
                provider,
                account: profile,
                result: "QUOTA_AVAILABLE",
              });
              if (!reported.ok) throw new Error(reported.error);
            } catch (error) {
              throw new Error(
                `REFUSED: could not sync current quota for ${provider}/${profile}: ${error instanceof Error ? error.message : error}`,
              );
            }
            if (w.remainingPercent <= 5) {
              console.log(
                `warning: remote remaining ~${w.remainingPercent}% (${w.label ?? w.kind}).`,
              );
            }
          }
        } else if (/\bHTTP 401\b/.test(u.error ?? "")) {
          try {
            const reported = await req({
              protocol: 1,
              action: "report",
              provider,
              account: profile,
              result: "AUTH_EXPIRED",
              detail: "remote_usage_http_401",
            });
            if (!reported.ok) throw new Error(reported.error);
          } catch (error) {
            throw new Error(
              `REFUSED: usage authentication failed for ${provider}/${profile} (HTTP 401); state update failed: ${error instanceof Error ? error.message : error}`,
            );
          }
          throw new Error(
            `REFUSED: usage authentication failed for ${provider}/${profile} (HTTP 401). Refresh or re-login, then try again.`,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("REFUSED:")) throw error;
        // network usage probe failed — fall through to daemon eligibility
      }

      const res = await req({ protocol: 1, action: "use", provider, profile, force });
      if (!res.ok) {
        const err = res.error || "use failed";
        if (/unknown account/i.test(err)) {
          throw new Error(`${err}\n${suggestAccounts(provider)}`);
        }
        throw new Error(err);
      }
      const data = res.data as {
        message?: string;
        profile?: string;
        activatedPaths?: string[];
        sinks?: SinkApplyResult[];
      };
      console.log(data.message ?? `now using ${provider}/${data.profile ?? profile}`);
      if (data.activatedPaths?.length) {
        console.log(`auth slot: ${data.activatedPaths.join(", ")}`);
      }
      for (const line of formatSinkResultLines(Array.isArray(data.sinks) ? data.sinks : [])) {
        console.log(line);
      }
      return;
    }
    case "auto": {
      const [provider, onoff] = rest;
      if (!provider || (onoff !== "on" && onoff !== "off")) {
        throw new Error("usage: oar auto <provider> on|off");
      }
      const res = await req({ protocol: 1, action: "auto", provider, enabled: onoff === "on" });
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data));
      return;
    }
    case "import-auth": {
      if (rest.includes("--all")) {
        rejectUnknownFlags(
          rest,
          new Set(["--all", "--from", "--force", "--profile"]),
          new Set(["--from", "--profile"]),
        );
      } else {
        rejectUnknownFlags(rest, new Set(["--from", "--account"]), new Set(["--from", "--account"]));
      }
      let from = join(homedir(), ".omo", "agent", "auth.json");
      const fromIdx = rest.indexOf("--from");
      if (fromIdx >= 0 && rest[fromIdx + 1]) from = rest[fromIdx + 1]!;

      if (rest.includes("--all")) {
        let profile = "main";
        const profileIdx = rest.indexOf("--profile");
        if (profileIdx >= 0 && rest[profileIdx + 1]) profile = rest[profileIdx + 1]!;
        const force = rest.includes("--force");
        const result = await withClient((c) => importAllFromAuthJson(c, { from, profile, force }));
        for (const provider of result.imported) console.log(`imported ${provider}/${profile}`);
        for (const provider of result.skipped) {
          console.log(`skipped ${provider}/${profile} (already in vault; use --force to overwrite)`);
        }
        for (const { provider, error } of result.errors) console.log(`failed ${provider}/${profile}: ${error}`);
        console.log(
          `import-auth --all: ${result.imported.length} imported, ${result.skipped.length} skipped, ${result.errors.length} failed (from ${from}; secrets stored under OAR vault, not logged)`,
        );
        if (result.errors.length > 0) process.exitCode = 1;
        return;
      }

      if (rest[0] === "default") {
        const value = rest[1];
        if (!value) {
          console.log(readImportAccountSetting());
          return;
        }
        writeImportAccountSetting(value);
        console.log(`import account default: ${value}`);
        return;
      }
      const [provider, profile] = positionalArgs(rest, new Set(["--from", "--account"]));
      if (!provider || !profile) {
        throw new Error("usage: oar import-auth <provider> <profile> [--from path] [--account <n|name|latest>]\n   or: oar import-auth default [primary|latest|<slot>]\n   or: oar import-auth --all [--from path] [--profile name] [--force]");
      }
      const accountIdx = rest.indexOf("--account");
      const flagged = accountIdx >= 0 ? rest[accountIdx + 1] : undefined;
      const positional = positionalArgs(rest, new Set(["--from", "--account"]));
      const extra = positional[2];
      const account = flagged ?? extra ?? readImportAccountSetting();
      const credential = readCredentialFromAuthJson(from, provider, { account });
      const used = importSelectionUsed(from, provider, account);
      const res = await req({
        protocol: 1,
        action: "import-credential",
        provider,
        profile,
        credential,
      });
      if (!res.ok) throw new Error(res.error);
      console.log(
        `imported ${provider}/${profile} from ${from} using ${used} (secrets stored under OAR vault, not logged)`,
      );
      return;
    }
    case "login": {
      const [provider, profile] = rest;
      if (!provider || !profile) throw new Error("usage: oar login <provider> <profile>");
      console.log(
        [
          `Interactive provider login stays in OMO/Senpi (device-code / OAuth) — OAR never automates it.`,
          `There is no \`omo auth login\` subcommand. Use the TUI \`/login\` command.`,
          ``,
          `First account (normal live agent dir ~/.omo/agent):`,
          `  1. omo`,
          `  2. /login  → select ${provider} → complete browser/device OAuth`,
          `  3. oar import-auth ${provider} ${profile}`,
          `  4. oar use ${provider} ${profile}`,
          ``,
          `Adding a SECOND account for the same provider:`,
          `  oar guide second-account`,
          ``,
          `Do not paste tokens into the shell.`,
        ].join("\n"),
      );
      return;
    }
    case "guide": {
      if (rest[0] !== "second-account") throw new Error("usage: oar guide second-account");
      console.log(secondAccountGuide());
      return;
    }
    case "install": {
      const scriptPath = join(__dirname, "..", "scripts", "install.sh");
      if (!existsSync(scriptPath)) {
        throw new Error(
          `install script not found at ${scriptPath}. Run scripts/install.sh directly from a full checkout.`,
        );
      }
      const result = spawnSync(scriptPath, rest, { stdio: "inherit" });
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
      }
      return;
    }
    case "logout": {
      const [provider, profile] = rest;
      if (!provider || !profile) throw new Error("usage: oar logout <provider> <profile>");
      const reported = await req({
        protocol: 1,
        action: "report",
        provider,
        account: profile,
        result: "AUTH_REVOKED",
        detail: "logout",
      });
      if (!reported.ok) throw new Error(reported.error);
      const res = await req({ protocol: 1, action: "remove", provider, profile });
      if (!res.ok) throw new Error(res.error);
      console.log(`logged out ${provider}/${profile} (vault removed; Senpi session not restarted)`);
      return;
    }
    case "activate": {
      const [provider, profile] = rest;
      if (!provider || !profile) throw new Error("usage: oar activate <provider> <profile>");
      const res = await req({ protocol: 1, action: "activate", provider, profile });
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data));
      return;
    }
    case "test": {
      rejectUnknownFlags(rest, new Set(["--live"]));
      const [provider, profile] = positionalArgs(rest);
      if (!provider || !profile) throw new Error("usage: oar test <provider> <profile> [--live]");
      const live = rest.includes("--live");
      const res = await req({ protocol: 1, action: "test", provider, profile, live });
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      if (live) {
        console.log(
          "(--live is a best-effort connectivity probe; it does not update routing state — see README design limits)",
        );
      }
      return;
    }
    case "report": {
      const [provider, profile, result] = rest;
      if (!provider || !profile || !result) throw new Error("usage: oar report <provider> <profile> <RESULT>");
      parseReportResult(result);
      const res = await req({
        protocol: 1,
        action: "report",
        provider,
        account: profile,
        result: result as never,
      });
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      return;
    }
    case "panel": {
      rejectUnknownFlags(
        rest,
        new Set(["--watch", "--json", "--xbar", "--hours", "--refresh", "--no-remote"]),
        new Set(["--hours"]),
      );
      const watchIdx = rest.indexOf("--watch");
      const json = rest.includes("--json");
      const xbar = rest.includes("--xbar");
      const refresh = rest.includes("--refresh");
      const noRemote = rest.includes("--no-remote");
      let hours = 24;
      const hoursIdx = rest.indexOf("--hours");
      if (hoursIdx >= 0 && rest[hoursIdx + 1]) {
        hours = Number(rest[hoursIdx + 1]);
        if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be a positive number");
      }
      let intervalSec = 0;
      if (watchIdx >= 0) {
        const maybe = rest[watchIdx + 1];
        intervalSec = maybe && !maybe.startsWith("--") ? Number(maybe) : 2;
        if (!Number.isFinite(intervalSec) || intervalSec <= 0) intervalSec = 2;
      }

      const root = process.env.OAR_HOME ?? defaultOarRoot();
      const store = new OarStore({ rootDir: root });

      const renderOnce = async () => {
        const res = await req({ protocol: 1, action: "status" });
        if (!res.ok) throw new Error(res.error);
        const status = res.data as StatusPayload;
        let remoteUsage = undefined as undefined | Awaited<ReturnType<typeof fetchRemoteUsageForAccounts>>;
        if (!noRemote) {
          const targets = (status.accounts ?? [])
            .filter((a) => isCodexProvider(a.provider) || isXaiProvider(a.provider))
            .map((a) => ({ provider: a.provider, profile: a.profile }));
          remoteUsage = await fetchRemoteUsageForAccounts(store, targets, {
            root,
            force: refresh,
            maxAgeMs: refresh ? 0 : 60_000,
          });
        }
        const snap = buildPanelSnapshot(status, {
          windowHours: hours,
          rootDir: root,
          remoteUsage,
        });
        if (json) console.log(JSON.stringify(snap, null, 2));
        else if (xbar) console.log(formatPanelXbar(snap));
        else console.log(formatPanelText(snap));
      };

      if (intervalSec > 0 && !json && !xbar) {
        for (;;) {
          process.stdout.write("\x1b[2J\x1b[H");
          await renderOnce();
          console.log(`\nwatching every ${intervalSec}s  ·  Ctrl+C to stop`);
          await new Promise((r) => setTimeout(r, intervalSec * 1000));
        }
      } else {
        await renderOnce();
      }
      return;
    }
    case "usage": {
      rejectUnknownFlags(rest, new Set(["--refresh"]));
      await warnIfDaemonDown("usage");
      const args = rest.filter((a) => !a.startsWith("--"));
      const root = process.env.OAR_HOME ?? defaultOarRoot();
      const store = new OarStore({ rootDir: root });
      const provider = args[0];
      const profile = args[1];
      const targets =
        provider && profile
          ? [{ provider, profile }]
          : store
              .listAccounts()
              .filter((a) => isCodexProvider(a.provider) || isXaiProvider(a.provider))
              .map((a) => ({ provider: a.provider, profile: a.profile }));
      if (targets.length === 0) {
        console.log("no openai-codex / xai accounts in vault");
        return;
      }
      const rows = await fetchRemoteUsageForAccounts(store, targets, {
        root,
        force: true,
      });
      // stable sort: provider then profile
      rows.sort((a, b) =>
        a.provider === b.provider ? a.profile.localeCompare(b.profile) : a.provider.localeCompare(b.provider),
      );
      // Push remote exhaustion into the *daemon* state (CLI store alone is not enough).
      for (const u of rows) {
        if (!u.ok) continue;
        const primary = u.windows.find((w) => w.remainingPercent != null) ?? u.windows[0];
        if (!primary || primary.remainingPercent == null) continue;
        if (primary.remainingPercent <= 0 || primary.limitReached) {
          try {
            await req({
              protocol: 1,
              action: "report",
              provider: u.provider,
              account: u.profile,
              result: "QUOTA_EXHAUSTED",
              detail: `remote_usage_${primary.label ?? primary.kind}_0`,
            });
          } catch {
            // daemon may be down; local cache still updated
          }
        }
      }
      console.log(formatUsageTable(rows));
      return;
    }
    case "recommend":
    case "recommand": {
      // accept common typo "recommand"
      rejectUnknownFlags(rest, new Set(["--refresh", "--cache", "--json"]));
      await warnIfDaemonDown("recommend");
      const json = rest.includes("--json");
      const refresh = rest.includes("--refresh") || !rest.includes("--cache");
      const providers = positionalArgs(rest);
      const root = process.env.OAR_HOME ?? defaultOarRoot();
      const store = new OarStore({ rootDir: root });
      // Prefer daemon account list so eligibility matches runtime
      try {
        const st = await req({ protocol: 1, action: "accounts" });
        if (st.ok && Array.isArray(st.data)) {
          // hydrate local store view is optional; scoring uses vault+daemon reports via usage side effects
        }
      } catch {
        /* ignore */
      }
      const rows = await buildRecommendations(store, {
        root,
        force: refresh,
        providers: providers.length ? providers : undefined,
      });
      // push 0% into daemon
      for (const r of rows) {
        if (r.remainingPercent != null && r.remainingPercent <= 0) {
          try {
            await req({
              protocol: 1,
              action: "report",
              provider: r.provider,
              account: r.profile,
              result: "QUOTA_EXHAUSTED",
              detail: "recommend_remote_0",
            });
          } catch {
            /* ignore */
          }
        }
      }
      if (json) {
        const top = rows.find((r) => r.score > 0 && r.eligibility === "ok");
        console.log(
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              topPick: top ? { provider: top.provider, profile: top.profile } : null,
              rows,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(formatRecommendTable(rows));
      }
      return;
    }
    case "bootstrap-auto": {
      const res = await req({ protocol: 1, action: "bootstrap-auto" });
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      return;
    }
    case "subscriptions": {
      const sub = rest[0];
      const root = process.env.OAR_HOME ?? defaultOarRoot();
      const subsStore = new SubscriptionsStore({ rootDir: root });
      const oarStore = new OarStore({ rootDir: root });

      if (sub === "list") {
        rejectUnknownFlags(rest.slice(1), new Set([]));
        console.log(formatSubscriptionsList(subsStore.list()));
        return;
      }

      if (sub === "set") {
        const valueFlags = new Set(["--monthly-usd", "--plan", "--billing-cycle-day", "--notes"]);
        rejectUnknownFlags(rest.slice(1), valueFlags, valueFlags);
        const [provider, profile] = positionalArgs(rest.slice(1), valueFlags);
        if (!provider || !profile) {
          throw new Error(
            "usage: oar subscriptions set <provider> <profile> --monthly-usd <n> [--plan \"label\"] [--billing-cycle-day N]",
          );
        }
        const usdIdx = rest.indexOf("--monthly-usd");
        if (usdIdx < 0 || !rest[usdIdx + 1]) {
          throw new Error("--monthly-usd is required and must be a non-negative number");
        }
        const monthlyUsd = Number(rest[usdIdx + 1]);
        let planLabel: string | undefined;
        const planIdx = rest.indexOf("--plan");
        if (planIdx >= 0 && rest[planIdx + 1]) planLabel = rest[planIdx + 1];
        let billingCycleDay: number | undefined;
        const cycleIdx = rest.indexOf("--billing-cycle-day");
        if (cycleIdx >= 0 && rest[cycleIdx + 1]) {
          billingCycleDay = Number(rest[cycleIdx + 1]);
          if (!Number.isFinite(billingCycleDay) || billingCycleDay < 1 || billingCycleDay > 31) {
            throw new Error("--billing-cycle-day must be 1–31");
          }
        }
        let notes: string | undefined;
        const notesIdx = rest.indexOf("--notes");
        if (notesIdx >= 0 && rest[notesIdx + 1]) notes = rest[notesIdx + 1];
        const saved = subsStore.set({
          provider,
          profile,
          monthlyUsd,
          ...(planLabel ? { planLabel } : {}),
          ...(billingCycleDay != null ? { billingCycleDay } : {}),
          ...(notes ? { notes } : {}),
        });
        console.log(
          `saved ${saved.provider}/${saved.profile} ${saved.planLabel ?? "plan"} @ $${saved.monthlyUsd}/mo`,
        );
        return;
      }

      if (sub === "remove") {
        rejectUnknownFlags(rest.slice(1), new Set([]));
        const [provider, profile] = rest.slice(1);
        if (!provider || !profile) {
          throw new Error("usage: oar subscriptions remove <provider> <profile>");
        }
        if (!subsStore.remove(provider, profile)) {
          throw new Error(`unknown subscription plan: ${provider}/${profile}`);
        }
        console.log(`removed subscription plan ${provider}/${profile}`);
        return;
      }

      if (sub === "audit") {
        rejectUnknownFlags(rest.slice(1), new Set(["--json", "--refresh"]));
        await warnIfDaemonDown("subscriptions audit");
        const json = rest.includes("--json");
        const refresh = rest.includes("--refresh");
        const result = await buildSubscriptionAudit(oarStore, subsStore, { root, force: refresh });
        if (json) console.log(JSON.stringify(auditToJson(result), null, 2));
        else console.log(formatAuditText(result));
        return;
      }

      throw new Error(
        "usage: oar subscriptions list|set|remove|audit\n" +
          "  oar subscriptions set <provider> <profile> --monthly-usd <n> [--plan \"label\"]",
      );
    }
    case "doctor": {
      console.log("OAR doctor");
      console.log(`root: ${process.env.OAR_HOME ?? defaultOarRoot()}`);
      console.log(`sock: ${process.env.OAR_SOCK ?? oarSocketPath()}`);
      const install = findSenpiInstall();
      if (install) {
        console.log(`omo-ai: ${install.omoAiVersion}`);
        console.log(`senpi:  ${install.senpiVersion}`);
        console.log(`engine: ${install.senpiRoot}`);
      } else {
        console.log("omo-ai/senpi install: not found");
      }
      console.log("active auth paths:");
      for (const p of resolveActiveAuthPaths()) {
        console.log(`  ${existsSync(p) ? "OK" : "--"} ${p}`);
      }
      console.log("discovered auth.json:");
      for (const p of discoverAuthJsonFiles()) {
        console.log(`  ${p}`);
      }
      await daemonStatus();
      const root = process.env.OAR_HOME ?? defaultOarRoot();
      const store = new OarStore({ rootDir: root });
      const codexAccounts = store
        .listAccounts()
        .filter((a) => isCodexProvider(a.provider))
        .map((a) => ({ provider: a.provider, profile: a.profile }));
      if (codexAccounts.length > 0) {
        const usageRows = await fetchRemoteUsageForAccounts(store, codexAccounts, {
          root,
          force: false,
          maxAgeMs: 300_000,
        });
        const authFailures = usageRows.filter((u) => !u.ok && /401|403|invalid_grant/i.test(u.error ?? ""));
        if (authFailures.length > 0) {
          console.log("");
          console.log("codex usage auth issue detected:");
          for (const u of authFailures) {
            console.log(`  ${u.provider}/${u.profile}: ${u.error ?? "HTTP auth error"}`);
          }
          console.log("  remediation:");
          console.log("    1. oar login openai-codex <profile>");
          console.log("    2. omo → /login → openai-codex → complete OAuth");
          console.log("    3. oar import-auth openai-codex <profile>");
          console.log("    4. oar test openai-codex <profile> --live");
          console.log("    5. oar usage openai-codex <profile> --refresh");
        }
      }
      console.log("");
      console.log("tips:");
      console.log("  oar panel --refresh   # accounts + remaining %");
      console.log("  oar usage --refresh   # Codex WK/5H + Grok %");
      console.log("  oar use <p> <profile> # hot-switch live slot");
      console.log("  oar bootstrap-auto   # enable multi-profile auto failover");
      console.log("  bash scripts/bootstrap-omo-oar.sh  # OMO+Cursor wire-up");
      return;
    }
    case "daemon": {
      const sub = rest[0];
      if (sub === "start") return daemonStart();
      if (sub === "stop") return daemonStop();
      if (sub === "status") return daemonStatus();
      throw new Error("usage: oar daemon start|stop|status");
    }
    default:
      throw new Error(`unknown command: ${cmd} (try: oar -h)`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
