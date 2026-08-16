import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OarClient } from "../src/client.ts";
import { OarStore } from "../src/store.ts";
import { AuthSlotActivator } from "../src/auth-slot.ts";
import { findSenpiInstall } from "../src/senpi-install.ts";

const install = findSenpiInstall();
const repoRoot = join(import.meta.dir, "..");

describe("Phase 1 — real Senpi AuthStorage hot-switch (no process restart)", () => {
  let root: string;
  let authPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-senpi-"));
    const agentDir = join(root, "agent");
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

  test.skipIf(!install)("installed engine is omo-ai 5.x + senpi 2026.8.12-4", () => {
    expect(install?.omoAiVersion).toContain("5.0.0");
    expect(install?.senpiVersion).toBe("2026.8.12-4");
  });

  test.skipIf(!install)(
    "child OAR daemon switches slot; parent Senpi AuthStorage reloads without restart",
    async () => {
      const mod = (await import(install!.authStoragePath)) as {
        AuthStorage: {
          create(path: string): { read(provider: string): Promise<{ access?: string; type?: string }> };
        };
      };
      const sessionStorage = mod.AuthStorage.create(authPath);
      expect((await sessionStorage.read("xai"))?.access).toBe("access-token-A");

      const oarHome = join(root, "oar");
      const sock = join(root, "oar.sock");
      const store = new OarStore({ rootDir: oarHome });
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

      const child = spawn("bun", ["run", "src/daemon-main.ts"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          OAR_HOME: oarHome,
          OAR_SOCK: sock,
          OAR_AUTH_PATH: authPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const client = new OarClient({ socketPath: sock, retries: 25, timeoutMs: 400 });
      try {
        const ping = await client.request({ protocol: 1, action: "ping" });
        expect(ping.ok).toBe(true);
        const used = await client.request({ protocol: 1, action: "use", provider: "xai", profile: "account-b" });
        expect(used.ok).toBe(true);

        const second = await sessionStorage.read("xai");
        expect(second?.access).toBe("access-token-B");
      } finally {
        child.kill("SIGTERM");
        await Bun.sleep(80);
      }
    },
  );

  test.skipIf(!install)(
    "atomic rename (other-process write style) is picked up by long-lived AuthStorage",
    async () => {
      const mod = (await import(install!.authStoragePath)) as {
        AuthStorage: { create(path: string): { read(provider: string): Promise<{ access?: string }> } };
      };
      const sessionStorage = mod.AuthStorage.create(authPath);
      expect((await sessionStorage.read("xai"))?.access).toBe("access-token-A");

      const store = new OarStore({ rootDir: join(root, "oar") });
      store.upsertAccount({
        provider: "xai",
        profile: "account-b",
        auth: "valid",
        availability: "AVAILABLE",
        priority: 1,
        credentialRef: "vault:xai:account-b",
      });
      store.putVaultCredential("xai", "account-b", {
        type: "oauth",
        access: "access-token-B",
        refresh: "refresh-token-B",
        expires: Date.now() + 3600_000,
      });
      const activator = new AuthSlotActivator({
        store,
        authPaths: [authPath],
        preferSenpiLock: false,
      });
      await activator.activate("xai", "account-b");
      expect((await sessionStorage.read("xai"))?.access).toBe("access-token-B");
    },
  );
});
