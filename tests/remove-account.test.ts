import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OarClient } from "../src/client.ts";
import { OarDaemon } from "../src/daemon.ts";
import { oarVaultDir } from "../src/paths.ts";
import { OarRouter } from "../src/router.ts";
import { OarStore } from "../src/store.ts";
import { SubscriptionsStore } from "../src/subscriptions/store.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function vaultFile(root: string, provider: string, profile: string): string {
  return join(oarVaultDir(root), `${provider}__${profile}.json`);
}

function seedPair(store: OarStore): void {
  store.upsertAccount({
    provider: "xai",
    profile: "account-a",
    auth: "valid",
    availability: "AVAILABLE",
    priority: 1,
    credentialRef: "vault:xai:account-a",
  });
  store.upsertAccount({
    provider: "xai",
    profile: "account-b",
    auth: "valid",
    availability: "AVAILABLE",
    priority: 2,
    credentialRef: "vault:xai:account-b",
  });
  store.putVaultCredential("xai", "account-a", {
    type: "oauth",
    access: "tok-A",
    refresh: "ref-A",
    expires: Date.now() + 3600_000,
  });
  store.putVaultCredential("xai", "account-b", {
    type: "oauth",
    access: "tok-B",
    refresh: "ref-B",
    expires: Date.now() + 3600_000,
  });
  store.setProviderMode("xai", "manual");
  store.setPreferred("xai", "account-a");
}

describe("oar remove account deletion", () => {
  let root: string;
  let sock: string;
  let authPath: string;
  let store: OarStore;
  let daemon: OarDaemon | null;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-remove-"));
    sock = join(root, "oar.sock");
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    authPath = join(agentDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        xai: { type: "oauth", access: "live-A", refresh: "live-R", expires: Date.now() + 3600_000 },
      }),
      { mode: 0o600 },
    );
    store = new OarStore({ rootDir: root });
    seedPair(store);
    daemon = new OarDaemon({
      store,
      socketPath: sock,
      authPaths: [authPath],
      activateOnUse: false,
    });
    await daemon.start();
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = null;
    rmSync(root, { recursive: true, force: true });
  });

  test("removing preferred profile clears preference and remaining account resolves", async () => {
    const client = new OarClient({ socketPath: sock });
    const removed = await client.request({
      protocol: 1,
      action: "remove",
      provider: "xai",
      profile: "account-a",
    });
    expect(removed.ok).toBe(true);

    expect(store.getAccount("xai", "account-a")).toBeUndefined();
    expect(store.getAccount("xai", "account-b")?.profile).toBe("account-b");
    expect(store.getProviderPolicy("xai").preferred).toBeUndefined();

    const resolved = await client.request({ protocol: 1, action: "resolve", provider: "xai" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect((resolved.data as { profile: string }).profile).toBe("account-b");
      expect((resolved.data as { status: string }).status).toBe("available");
    }

    const useGone = await client.request({
      protocol: 1,
      action: "use",
      provider: "xai",
      profile: "account-a",
    });
    expect(useGone.ok).toBe(false);
    if (!useGone.ok) expect(useGone.error).toMatch(/unknown account/i);
  });

  test("target vault credential is deleted; sibling credentials remain", async () => {
    const client = new OarClient({ socketPath: sock });
    const removed = await client.request({
      protocol: 1,
      action: "remove",
      provider: "xai",
      profile: "account-a",
    });
    expect(removed.ok).toBe(true);

    expect(store.getVaultCredential("xai", "account-a")).toBeUndefined();
    expect(existsSync(vaultFile(root, "xai", "account-a"))).toBe(false);
    const sibling = store.getVaultCredential("xai", "account-b");
    expect(sibling?.type).toBe("oauth");
    if (sibling?.type === "oauth") {
      expect(sibling.access).toBe("tok-B");
    }
  });

  test("unknown account reports failure without mutating vault", async () => {
    const client = new OarClient({ socketPath: sock });
    const missing = await client.request({
      protocol: 1,
      action: "remove",
      provider: "xai",
      profile: "no-such",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe("unknown account xai/no-such");
    expect(store.getAccount("xai", "account-a")?.profile).toBe("account-a");
    expect(existsSync(vaultFile(root, "xai", "account-a"))).toBe(true);
  });

  test("CLI remove against isolated daemon succeeds and missing profile exits 1", async () => {
    const env = { ...process.env, OAR_HOME: root, OAR_SOCK: sock };
    const ok = Bun.spawn(["bun", cliPath, "remove", "xai", "account-a"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [okOut, okErr, okCode] = await Promise.all([
      new Response(ok.stdout).text(),
      new Response(ok.stderr).text(),
      ok.exited,
    ]);
    expect(okCode).toBe(0);
    expect(okOut).toContain("removed xai/account-a");
    expect(okErr).toBe("");
    expect(store.getAccount("xai", "account-a")).toBeUndefined();

    const missing = Bun.spawn(["bun", cliPath, "remove", "xai", "ghost"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [missOut, missErr, missCode] = await Promise.all([
      new Response(missing.stdout).text(),
      new Response(missing.stderr).text(),
      missing.exited,
    ]);
    expect(missCode).toBe(1);
    expect(`${missOut}${missErr}`).toMatch(/unknown account xai\/ghost/);
  });

  test("remove does not rewrite live auth slot or subscription records", async () => {
    const subs = new SubscriptionsStore({ rootDir: root });
    subs.set({ provider: "xai", profile: "account-a", monthlyUsd: 30, planLabel: "keep-me" });
    const liveBefore = readFileSync(authPath, "utf8");

    const client = new OarClient({ socketPath: sock });
    const removed = await client.request({
      protocol: 1,
      action: "remove",
      provider: "xai",
      profile: "account-a",
    });
    expect(removed.ok).toBe(true);

    expect(readFileSync(authPath, "utf8")).toBe(liveBefore);
    expect(subs.get("xai", "account-a")?.planLabel).toBe("keep-me");
  });

  test("stale in-memory leases for the removed account leave daemon status", async () => {
    const client = new OarClient({ socketPath: sock });
    const lease = await client.request({
      protocol: 1,
      action: "acquire-lease",
      provider: "xai",
      profile: "account-a",
      holder: "worker-1",
    });
    expect(lease.ok).toBe(true);
    const keep = await client.request({
      protocol: 1,
      action: "acquire-lease",
      provider: "xai",
      profile: "account-b",
      holder: "worker-2",
    });
    expect(keep.ok).toBe(true);

    const removed = await client.request({
      protocol: 1,
      action: "remove",
      provider: "xai",
      profile: "account-a",
    });
    expect(removed.ok).toBe(true);

    const status = await client.request({ protocol: 1, action: "status" });
    expect(status.ok).toBe(true);
    if (status.ok) {
      const leases = (status.data as { leases: Array<{ provider: string; profile: string }> }).leases;
      expect(leases.some((l) => l.provider === "xai" && l.profile === "account-a")).toBe(false);
      expect(leases.some((l) => l.provider === "xai" && l.profile === "account-b")).toBe(true);
    }
  });

  test("vault unlink failure is observable and does not claim success", () => {
    const path = vaultFile(root, "xai", "account-a");
    unlinkSync(path);
    mkdirSync(path);
    writeFileSync(join(path, "stuck"), "x", { mode: 0o600 });
    expect(() => store.removeAccount("xai", "account-a")).toThrow();
    expect(store.getAccount("xai", "account-a")?.profile).toBe("account-a");
    expect(store.getProviderPolicy("xai").preferred).toBe("account-a");
    expect(existsSync(join(path, "stuck"))).toBe(true);
  });

  test("store remove clears preferred and leftover account still resolves", () => {
    store.removeAccount("xai", "account-a");
    expect(store.getProviderPolicy("xai").preferred).toBeUndefined();
    const router = new OarRouter(store);
    const r = router.resolve({ provider: "xai" });
    expect(r.profile).toBe("account-b");
    expect(r.status).toBe("available");
    expect(() => router.use("xai", "account-a")).toThrow(/unknown account/i);
  });
});
