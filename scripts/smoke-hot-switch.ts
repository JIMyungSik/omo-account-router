import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { OarClient } from "../src/client.ts";

const smoke = join("/tmp", `oar-smoke-${process.pid}`);
const oarHome = join(smoke, "oar");
const agentDir = join(smoke, "agent");
const sock = join(smoke, "oar.sock");
const auth = join(agentDir, "auth.json");

mkdirSync(agentDir, { recursive: true });
mkdirSync(oarHome, { recursive: true });
writeFileSync(
  auth,
  JSON.stringify({
    xai: { type: "oauth", access: "tok-A", refresh: "ref-A", expires: 9999999999999 },
  }),
);

const env = {
  ...process.env,
  OAR_HOME: oarHome,
  OAR_SOCK: sock,
  OMO_CODING_AGENT_DIR: agentDir,
  OAR_AUTH_PATH: auth,
  OAR_SINKS: "0",
};

const daemon = spawn("bun", ["run", "src/daemon-main.ts"], {
  cwd: join(import.meta.dir, ".."),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

function waitForDaemonListening(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
        reject(new Error(`daemon ready timeout after ${timeoutMs}ms: ${buf}`));
      });
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (/oar-daemon listening/.test(buf)) finish(() => resolve());
    };
    const onError = (error: Error) => {
      finish(() => reject(error));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => reject(new Error(`daemon exited ${code ?? signal} before ready: ${buf}`)));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`daemon close timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", onClose);
    if (child.exitCode != null || child.signalCode != null) {
      child.off("close", onClose);
      clearTimeout(timer);
      resolve();
    }
  });
}

function access(): string {
  return JSON.parse(readFileSync(auth, "utf8")).xai.access;
}

let failed = false;
try {
  await waitForDaemonListening(daemon, 15_000);
  const client = new OarClient({ socketPath: sock, retries: 0 });
  const ping = await client.request({ protocol: 1, action: "ping" });
  if (!ping.ok) throw new Error("ping failed");

  for (const profile of ["account-a", "account-b"]) {
    const r = await client.request({ protocol: 1, action: "add", provider: "xai", profile });
    if (!r.ok) throw new Error(r.error);
  }
  let r = await client.request({
    protocol: 1,
    action: "import-credential",
    provider: "xai",
    profile: "account-a",
    credential: { type: "oauth", access: "tok-A", refresh: "ref-A", expires: 9999999999999 },
  });
  if (!r.ok) throw new Error(r.error);
  r = await client.request({
    protocol: 1,
    action: "import-credential",
    provider: "xai",
    profile: "account-b",
    credential: { type: "oauth", access: "tok-B", refresh: "ref-B", expires: 9999999999999 },
  });
  if (!r.ok) throw new Error(r.error);

  r = await client.request({ protocol: 1, action: "use", provider: "xai", profile: "account-a" });
  if (!r.ok) throw new Error(r.error);
  const afterA = access();
  r = await client.request({ protocol: 1, action: "use", provider: "xai", profile: "account-b" });
  if (!r.ok) throw new Error(r.error);
  const afterB = access();

  console.log(JSON.stringify({ afterA, afterB, pass: afterA === "tok-A" && afterB === "tok-B" }, null, 2));
  if (afterA !== "tok-A" || afterB !== "tok-B") {
    failed = true;
    process.exitCode = 1;
  }
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  let stopError: unknown;
  const closed = waitForChildClose(daemon, 8_000);
  if (daemon.exitCode == null && daemon.signalCode == null) daemon.kill("SIGTERM");
  try {
    await closed;
  } catch (error) {
    stopError = error;
    if (daemon.exitCode == null && daemon.signalCode == null) daemon.kill("SIGKILL");
  }
  rmSync(smoke, { recursive: true, force: true });
  if (stopError) {
    failed = true;
    console.error(stopError instanceof Error ? stopError.message : stopError);
    process.exitCode = 1;
  }
}

if (failed) process.exitCode = 1;
