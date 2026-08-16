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
import { OarStore } from "./store.ts";
import { fetchRemoteUsage, fetchRemoteUsageForAccounts } from "./usage/fetch.ts";
import { formatUsageTable } from "./usage/format.ts";
import type { AccountRecord, StoredCredential } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function usage(): string {
  return `oar — OMO Account Router

Usage:
  oar status
  oar accounts [provider]
  oar provider list
  oar add <provider> <profile>
  oar remove <provider> <profile>
  oar use <provider> <profile>
  oar auto <provider> on|off
  oar import-auth <provider> <profile> [--from <auth.json>]
  oar import-auth --all [--from <auth.json>] [--profile <name>] [--force]
  oar login <provider> <profile>
  oar logout <provider> <profile>
  oar activate <provider> <profile>
  oar test <provider> <profile> [--live]
  oar report <provider> <profile> <RESULT>
  oar guide second-account
  oar install [-- <install.sh args>]
  oar panel [--watch [sec]] [--json] [--xbar] [--hours N] [--refresh] [--no-remote]
  oar usage [provider] [profile] [--refresh]
  oar doctor
  oar daemon start|stop|status

Environment:
  OAR_HOME   state root (default ~/.oar)
  OAR_SOCK   unix socket path
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

function printStatus(data: {
  accounts: AccountRecord[];
  resolvePreview: Array<{ provider: string; profile: string; status: string }>;
  authPaths: string[];
  state: { providers: Record<string, { mode: string; preferred?: string; autoFailover: boolean }> };
}) {
  const active = new Map(data.resolvePreview.map((r) => [`${r.provider}`, r.profile]));
  console.log("PROVIDER   PROFILE            AUTH       STATUS            MODE     ACTIVE");
  for (const a of data.accounts) {
    const pol = data.state.providers[a.provider];
    const mode = pol?.mode ?? "manual";
    const star = active.get(a.provider) === a.profile ? "★" : "";
    console.log(
      `${a.provider.padEnd(10)} ${a.profile.padEnd(18)} ${a.auth.padEnd(10)} ${a.availability.padEnd(16)} ${mode.padEnd(8)} ${star}`,
    );
  }
  console.log("");
  console.log("auth paths (active slot writes):");
  for (const p of data.authPaths) console.log(`  ${p}`);
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

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(usage());
    return;
  }

  switch (cmd) {
    case "status": {
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok) throw new Error(res.error);
      printStatus(res.data as Parameters<typeof printStatus>[0]);
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
      const [provider, profile] = rest;
      if (!provider || !profile) throw new Error("usage: oar use <provider> <profile>");
      const res = await req({ protocol: 1, action: "use", provider, profile });
      if (!res.ok) throw new Error(res.error);
      const data = res.data as { message?: string; profile?: string };
      console.log(data.message ?? `now using ${provider}/${data.profile ?? profile}`);
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
      console.log(formatUsageTable(rows));
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
