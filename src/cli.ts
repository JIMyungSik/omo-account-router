#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OarClient } from "./client.ts";
import {
  defaultOarRoot,
  discoverAuthJsonFiles,
  oarSocketPath,
  resolveActiveAuthPaths,
} from "./paths.ts";
import type { OarRequest } from "./protocol.ts";
import { findSenpiInstall } from "./senpi-install.ts";
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
  oar login <provider> <profile>
  oar logout <provider> <profile>
  oar activate <provider> <profile>
  oar test <provider> <profile>
  oar report <provider> <profile> <RESULT>
  oar doctor
  oar daemon start|stop|status

Environment:
  OAR_HOME   state root (default ~/.oar)
  OAR_SOCK   unix socket path
`;
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

  const daemonEntry = existsSync(join(__dirname, "daemon-main.ts"))
    ? join(__dirname, "daemon-main.ts")
    : join(__dirname, "daemon-main.js");

  const child = spawn("bun", [daemonEntry], {
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
      const provider = rest[0];
      const profile = rest[1];
      if (!provider || !profile) throw new Error("usage: oar import-auth <provider> <profile> [--from path]");
      let from = join(homedir(), ".omo", "agent", "auth.json");
      const fromIdx = rest.indexOf("--from");
      if (fromIdx >= 0 && rest[fromIdx + 1]) from = rest[fromIdx + 1]!;
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
          `Interactive provider login stays in OMO/Senpi (device-code / OAuth).`,
          `1. omo auth login ${provider}`,
          `2. bun run src/cli.ts import-auth ${provider} ${profile}`,
          `3. bun run src/cli.ts use ${provider} ${profile}`,
          `Do not paste tokens into the shell.`,
        ].join("\n"),
      );
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
      if (!provider || !profile) throw new Error("usage: oar test <provider> <profile>");
      const res = await req({ protocol: 1, action: "test", provider, profile });
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
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
