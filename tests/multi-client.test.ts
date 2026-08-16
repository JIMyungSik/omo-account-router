import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarDaemon } from "../src/daemon.ts";
import { OarClient } from "../src/client.ts";
import { OarStore } from "../src/store.ts";

describe("Multi-client shared daemon state", () => {
  let root: string;
  let sock: string;
  let daemon: OarDaemon;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-multi-"));
    sock = join(root, "oar.sock");
    const store = new OarStore({ rootDir: root });
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
    store.setProviderMode("xai", "manual");
    store.setPreferred("xai", "account-a");
    // Routing-only multi-client test: activation needs vault creds + auth.json paths.
    daemon = new OarDaemon({ store, socketPath: sock, activateOnUse: false });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("client1 use B is visible to client2 resolve", async () => {
    const c1 = new OarClient({ socketPath: sock });
    const c2 = new OarClient({ socketPath: sock });
    const before = await c2.request({ protocol: 1, action: "resolve", provider: "xai" });
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.data.profile).toBe("account-a");

    const used = await c1.request({
      protocol: 1,
      action: "use",
      provider: "xai",
      profile: "account-b",
    });
    expect(used.ok).toBe(true);

    const after = await c2.request({ protocol: 1, action: "resolve", provider: "xai" });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.data.profile).toBe("account-b");
  });
});
