import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthSlotActivator } from "../src/auth-slot.ts";
import { OarStore } from "../src/store.ts";
import { OarRouter } from "../src/router.ts";
import { simulateSenpiAuthRead } from "../src/senpi-auth-sim.ts";

/**
 * Hot-switch PoC against Senpi's real mechanism:
 * AuthStorage.readLatestData reloads when auth.json file revision changes.
 * We simulate that reader and prove A → B without process restart.
 */
describe("Hot Switch via auth.json slot activation", () => {
  let root: string;
  let agentDir: string;
  let authPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-hot-"));
    agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    authPath = join(agentDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify(
        {
          xai: {
            type: "oauth",
            access: "access-token-A",
            refresh: "refresh-token-A",
            expires: Date.now() + 3600_000,
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("same process sees account B after oar use without restart", async () => {
    const store = new OarStore({ rootDir: join(root, "oar") });
    const router = new OarRouter(store);
    const activator = new AuthSlotActivator({
      store,
      authPaths: [authPath],
    });

    // Import/register two vault accounts (mock credentials — never real tokens in tests)
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
      access: "access-token-A",
      refresh: "refresh-token-A",
      expires: Date.now() + 3600_000,
    });
    store.putVaultCredential("xai", "account-b", {
      type: "oauth",
      access: "access-token-B",
      refresh: "refresh-token-B",
      expires: Date.now() + 3600_000,
    });
    store.setProviderMode("xai", "manual");
    store.setPreferred("xai", "account-a");
    await activator.activate("xai", "account-a");

    // Senpi-like in-process reader (revision cache)
    const reader = simulateSenpiAuthRead(authPath);
    const first = await reader.read("xai");
    expect(first?.type).toBe("oauth");
    if (first?.type === "oauth") {
      expect(first.access).toBe("access-token-A");
    }

    // Hot switch — no process restart
    router.use("xai", "account-b");
    await activator.activate("xai", "account-b");

    const second = await reader.read("xai");
    expect(second?.type).toBe("oauth");
    if (second?.type === "oauth") {
      expect(second.access).toBe("access-token-B");
    }

    // conversation/session identity untouched (auth.json only)
    const disk = JSON.parse(readFileSync(authPath, "utf8"));
    expect(disk.xai.access).toBe("access-token-B");
    expect(router.resolve({ provider: "xai" }).profile).toBe("account-b");
  });
});
