import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarClient } from "../src/client.ts";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";

describe("Daemon restart does not require OMO restart", () => {
  let root: string;
  let sock: string;
  let authPath: string;
  let store: OarStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-drestart-"));
    sock = join(root, "oar.sock");
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    authPath = join(agentDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({}), { mode: 0o600 });
    store = new OarStore({ rootDir: root });
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
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("preferred account survives daemon stop/start; client reconnects", async () => {
    const d1 = new OarDaemon({ store, socketPath: sock, authPaths: [authPath], activateOnUse: true });
    await d1.start();
    const c1 = new OarClient({ socketPath: sock });
    const used = await c1.request({ protocol: 1, action: "use", provider: "xai", profile: "account-b" });
    expect(used.ok).toBe(true);
    await d1.stop();

    const d2 = new OarDaemon({
      store: new OarStore({ rootDir: root }),
      socketPath: sock,
      authPaths: [authPath],
      activateOnUse: true,
    });
    await d2.start();
    try {
      const c2 = new OarClient({ socketPath: sock, retries: 6 });
      const resolved = await c2.request({ protocol: 1, action: "resolve", provider: "xai" });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect((resolved.data as { profile: string }).profile).toBe("account-b");
      }
    } finally {
      await d2.stop();
    }
  });
});
