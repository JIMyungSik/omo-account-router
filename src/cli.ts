#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OarClient } from "./client.ts";
import { importAllFromAuthJson } from "./import-all.ts";
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
import { fetchRemoteUsage, fetchRemoteUsageForAccounts } from "./usage/fetch.ts";
import { formatUsageTable } from "./usage/format.ts";
import { buildRecommendations, formatRecommendTable } from "./usage/recommend.ts";
import type { AccountRecord, StoredCredential } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function usage(): string {
  return `oar — OMO Account Router

Local multi-account hot-switch for OMO/Senpi. OAR stores credentials in a vault,
copies the active profile into live auth.json slot(s), and tracks routing state.
OAR routes and copies credentials; it does NOT automate OAuth login and does NOT
revoke provider refresh tokens.

Tip: run \`oar\` with no args for a quick status snapshot (not this help text).

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
      Quick status snapshot when the daemon is up; same table as \`oar status\`.
      On daemon failure, prints this help plus a start hint.

  oar status [--json]
      Markdown table: * PROVIDER PROFILE AUTH STATUS MODE AUTO NOTE.
      Header counts accounts / active / problematic. No remote usage fetch.
      --json  Structured rows + summary (exit 0).

  oar accounts [provider]
      JSON list of vault accounts; optional filter by provider id.

  oar provider list
      One provider id per line from registered accounts.

  oar add <provider> <profile>
      Register a named profile slot (no credential yet).

  oar remove <provider> <profile>
      Remove profile from vault and daemon state.

  oar use <provider> <profile> [--force]
      Switch live auth slot to this vault profile. Refreshes remote usage first;
      refuses switch at 0% remaining unless --force. No OMO restart needed.

  oar auto <provider> on|off
      Enable/disable automatic failover to another eligible profile on failures.

  oar bootstrap-auto
      One-shot: for every provider with 2+ vault profiles, set mode=auto +
      autoFailover, and ensureActivated the preferred profile. OMO extension
      also runs this on session_start so daily use needs no manual oar.

  oar import-auth <provider> <profile> [--from <auth.json>]
      Copy one provider credential from auth.json (default ~/.omo/agent/auth.json)
      into the OAR vault. Secrets stay in the vault; nothing is printed.

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
      Remote quota table for openai-codex and xai (5H/WK/Grok %). OK = request ok.
      Omit args to list all supported accounts. Updates daemon on 0% exhaustion.

  oar recommend [--refresh] [provider...]
      Rank profiles by eligibility + remote remaining %. Optional provider filter.
      --refresh  Fetch fresh usage (default). Daemon must be running for full sync.

  oar doctor
      Local diagnostics: paths, Senpi install, auth.json discovery, daemon JSON.

  oar daemon start|stop|status
      Background unix-socket daemon (required for most commands).
      start   Detach daemon.  stop   SIGTERM.  status   JSON doctor payload.

ENVIRONMENT
  OAR_HOME   State root and vault (default ~/.oar)
  OAR_SOCK   Unix socket path (default under OAR_HOME)

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

function printStatus(
  data: {
    accounts: AccountRecord[];
    resolvePreview: Array<{ provider: string; profile: string; status: string }>;
    authPaths: string[];
    state: { providers: Record<string, { mode: string; preferred?: string; autoFailover: boolean }> };
  },
  opts?: { json?: boolean },
) {
  const view = buildStatusView(data);
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

function readCredentialFromAuthJson(authPath: string, provider: string): StoredCredential {
  const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, StoredCredential>;
  const cred = data[provider];
  if (!cred) throw new Error(`provider ${provider} not found in ${authPath}`);
  if (cred.type !== "oauth" && cred.type !== "api_key") {
    throw new Error(`unsupported credential type in ${authPath}`);
  }
  return cred;
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
  // Bare \`oar\` → friendly snapshot (not a wall of help).
  if (!cmd) {
    try {
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok) throw new Error(res.error);
      const data = res.data as Parameters<typeof printStatus>[0];
      printStatus(data);
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
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok) throw new Error(res.error);
      printStatus(res.data as Parameters<typeof printStatus>[0], { json: rest.includes("--json") });
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
      const [provider, profile] = rest;
      if (!provider || !profile) throw new Error("usage: oar remove <provider> <profile>");
      const res = await req({ protocol: 1, action: "remove", provider, profile });
      if (!res.ok) throw new Error(res.error);
      console.log(`removed ${provider}/${profile}`);
      return;
    }
    case "use": {
      const force = rest.includes("--force");
      const args = rest.filter((a) => a !== "--force");
      const [provider, profile] = args;
      if (!provider || !profile) {
        throw new Error("usage: oar use <provider> <profile> [--force]\n" + suggestAccounts());
      }

      // Refresh usage when possible; block 0% unless --force (even if auto is on).
      const root = process.env.OAR_HOME ?? defaultOarRoot();
      const store = new OarStore({ rootDir: root });
      try {
        const u = await fetchRemoteUsage(store, provider, profile, {
          root,
          force: true,
          maxAgeMs: 0,
        });
        if (u.ok) {
          const w = u.windows.find((x) => x.remainingPercent != null) ?? u.windows[0];
          if (w?.remainingPercent != null && w.remainingPercent <= 0) {
            console.error(
              `WARNING: ${provider}/${profile} remote remaining is 0% (${w.label ?? w.kind}).`,
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
                `REFUSED: not switching to ${provider}/${profile} at 0%. ` +
                  `Auto failover will also skip it. Use another profile, or --force to override.`,
              );
            }
            console.error("  --force set: switching anyway.");
          } else if (w?.remainingPercent != null && w.remainingPercent <= 5) {
            console.log(
              `warning: remote remaining ~${w.remainingPercent}% (${w.label ?? w.kind}).`,
            );
          }
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
      const data = res.data as { message?: string; profile?: string; activatedPaths?: string[] };
      console.log(data.message ?? `now using ${provider}/${data.profile ?? profile}`);
      if (data.activatedPaths?.length) {
        console.log(`auth slot: ${data.activatedPaths.join(", ")}`);
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

      const [provider, profile] = rest;
      if (!provider || !profile) {
        throw new Error("usage: oar import-auth <provider> <profile> [--from path]\n   or: oar import-auth --all [--from path] [--profile name] [--force]");
      }
      const credential = readCredentialFromAuthJson(from, provider);
      const res = await req({
        protocol: 1,
        action: "import-credential",
        provider,
        profile,
        credential,
      });
      if (!res.ok) throw new Error(res.error);
      console.log(`imported ${provider}/${profile} from ${from} (secrets stored under OAR vault, not logged)`);
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
      const [provider, profile] = rest;
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
            .filter((a) => a.provider === "openai-codex" || a.provider === "xai")
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
      const refresh = rest.includes("--refresh");
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
              .filter((a) => a.provider === "openai-codex" || a.provider === "xai")
              .map((a) => ({ provider: a.provider, profile: a.profile }));
      if (targets.length === 0) {
        console.log("no openai-codex / xai accounts in vault");
        return;
      }
      const rows = await fetchRemoteUsageForAccounts(store, targets, {
        root,
        force: refresh || true,
        maxAgeMs: 0,
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
      const refresh = rest.includes("--refresh") || !rest.includes("--cache");
      const providers = rest.filter((a) => !a.startsWith("--"));
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
      console.log(formatRecommendTable(rows));
      return;
    }
    case "bootstrap-auto": {
      const res = await req({ protocol: 1, action: "bootstrap-auto" });
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      return;
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
      throw new Error(`unknown command: ${cmd}\n${usage()}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
