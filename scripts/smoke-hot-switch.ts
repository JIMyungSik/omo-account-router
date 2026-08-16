import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
};

const daemon = spawn("bun", ["run", "src/daemon-main.ts"], {
  cwd: join(import.meta.dir, ".."),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

const client = new OarClient({ socketPath: sock });

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await client.request({ protocol: 1, action: "ping" });
      if (r.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(50);
  }
  throw new Error("daemon not ready");
}

function access(): string {
  return JSON.parse(readFileSync(auth, "utf8")).xai.access;
}

try {
  await waitReady();
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
  if (afterA !== "tok-A" || afterB !== "tok-B") process.exitCode = 1;
} finally {
  daemon.kill("SIGTERM");
  await Bun.sleep(100);
  rmSync(smoke, { recursive: true, force: true });
}
