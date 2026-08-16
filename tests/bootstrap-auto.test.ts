import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";

describe("bootstrap-auto + AUTH_EXPIRED failover", () => {
  let root: string;
  let store: OarStore;
  let daemon: OarDaemon;
  let authPath: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-boot-"));
    authPath = join(root, "auth.json");
    store = new OarStore({ rootDir: join(root, "oar") });
    for (const profile of ["main", "sub"] as const) {
      store.upsertAccount({
        provider: "xai",
        profile,
        auth: "valid",
        availability: "AVAILABLE",
        priority: profile === "main" ? 10 : 20,
        credentialRef: `vault:xai:${profile}`,
      });
      store.putVaultCredential("xai", profile, {
        type: "oauth",
        access: `${profile}-access`,
        refresh: `${profile}-refresh`,
        expires: Date.now() + 3_600_000,
      });
    }
    store.setPreferred("xai", "main");
    store.setProviderMode("xai", "manual");
    store.setAutoFailover("xai", false);
    daemon = new OarDaemon({
      store,
      socketPath: join(root, "oar.sock"),
      authPaths: [authPath],
      activateOnUse: true,
      preferSenpiLock: false,
    });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("bootstrap-auto enables auto+failover for multi-profile providers", async () => {
    const res = await daemon.dispatch({ protocol: 1, action: "bootstrap-auto" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { enabled: Array<{ provider: string }> };
    expect(data.enabled.some((e) => e.provider === "xai")).toBe(true);
    const policy = store.getProviderPolicy("xai");
    expect(policy.mode).toBe("auto");
    expect(policy.autoFailover).toBe(true);
  });

  test("AUTH_EXPIRED report failovers to next profile when auto is on", async () => {
    await daemon.dispatch({ protocol: 1, action: "bootstrap-auto" });
    const reported = await daemon.dispatch({
      protocol: 1,
      action: "report",
      provider: "xai",
      account: "main",
      result: "AUTH_EXPIRED",
    });
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    const data = reported.data as { failover?: { from: string; to: string } };
    expect(data.failover?.from).toBe("main");
    expect(data.failover?.to).toBe("sub");
    const resolved = await daemon.dispatch({ protocol: 1, action: "resolve", provider: "xai" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect((resolved.data as { profile: string }).profile).toBe("sub");
  });
});
