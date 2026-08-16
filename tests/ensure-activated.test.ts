import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthSlotActivator, credentialsEqual, isFresherOAuth } from "../src/auth-slot.ts";
import { OarStore } from "../src/store.ts";

describe("ensureActivated prevents slot drift", () => {
  let root: string;
  let authPath: string;
  let store: OarStore;
  const now = Date.now();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-ensure-"));
    const agent = join(root, "agent");
    mkdirSync(agent, { recursive: true });
    authPath = join(agent, "auth.json");
    store = new OarStore({ rootDir: join(root, "oar") });
    store.upsertAccount({
      provider: "xai",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 100,
      credentialRef: "vault:xai:main",
    });
    store.upsertAccount({
      provider: "xai",
      profile: "sub",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 100,
      credentialRef: "vault:xai:sub",
    });
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: "main-access",
      refresh: "main-refresh",
      expires: now + 3600_000,
    });
    store.putVaultCredential("xai", "sub", {
      type: "oauth",
      access: "sub-access",
      refresh: "sub-refresh",
      expires: now + 3600_000,
    });
    writeFileSync(
      authPath,
      JSON.stringify({
        xai: { type: "oauth", access: "main-access", refresh: "main-refresh", expires: now + 3600_000 },
      }),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("rewrites live slot when it still has the other profile", async () => {
    const act = new AuthSlotActivator({ store, authPaths: [authPath], preferSenpiLock: false });
    const r = await act.ensureActivated("xai", "sub");
    expect(r.skipped).toBe(false);
    const live = JSON.parse(readFileSync(authPath, "utf8")).xai.access;
    expect(live).toBe("sub-access");
    const again = await act.ensureActivated("xai", "sub");
    expect(again.skipped).toBe(true);
  });

  test("pulls vault up from live when Senpi refreshed the same profile", async () => {
    const vaultBefore = store.getVaultCredential("xai", "sub");
    if (!vaultBefore || vaultBefore.type !== "oauth") throw new Error("missing sub vault");
    const refreshed = {
      type: "oauth" as const,
      access: "sub-access-refreshed",
      refresh: "sub-refresh-rotated",
      expires: vaultBefore.expires + 3_600_000,
    };
    writeFileSync(authPath, JSON.stringify({ xai: refreshed }));

    const act = new AuthSlotActivator({ store, authPaths: [authPath], preferSenpiLock: false });
    const r = await act.ensureActivated("xai", "sub");
    expect(r.skipped).toBe(false);
    expect(r.via).toContain("vault-pull-up");

    const vaultAfter = store.getVaultCredential("xai", "sub");
    expect(vaultAfter).toEqual(refreshed);
    const live = JSON.parse(readFileSync(authPath, "utf8")).xai;
    expect(live).toEqual(refreshed);
    // Must not clobber live back to the stale pre-refresh vault values.
    expect(live.refresh).not.toBe("sub-refresh");
    expect(live.access).not.toBe("sub-access");
  });

  test("does not pull vault up when live is another known profile even if fresher", async () => {
    // Preferred sub; live still holds main, with a longer expiry (stale switch).
    writeFileSync(
      authPath,
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "main-access",
          refresh: "main-refresh",
          expires: now + 10_000_000,
        },
      }),
    );
    const act = new AuthSlotActivator({ store, authPaths: [authPath], preferSenpiLock: false });
    const r = await act.ensureActivated("xai", "sub");
    expect(r.skipped).toBe(false);
    expect(r.via).toContain("profile-realign");
    const live = JSON.parse(readFileSync(authPath, "utf8")).xai;
    expect(live.access).toBe("sub-access");
    expect(live.refresh).toBe("sub-refresh");
    // sub vault must not be poisoned with main credentials
    const subVault = store.getVaultCredential("xai", "sub");
    expect(subVault?.type === "oauth" && subVault.access).toBe("sub-access");
  });

  test("pushes vault when live is older than vault", async () => {
    store.putVaultCredential("xai", "sub", {
      type: "oauth",
      access: "sub-access-new",
      refresh: "sub-refresh-new",
      expires: now + 7_200_000,
    });
    writeFileSync(
      authPath,
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "sub-access-old",
          refresh: "sub-refresh-old",
          expires: now + 60_000,
        },
      }),
    );
    const act = new AuthSlotActivator({ store, authPaths: [authPath], preferSenpiLock: false });
    const r = await act.ensureActivated("xai", "sub");
    expect(r.skipped).toBe(false);
    const live = JSON.parse(readFileSync(authPath, "utf8")).xai;
    expect(live.access).toBe("sub-access-new");
    expect(live.refresh).toBe("sub-refresh-new");
  });
});

describe("oauth freshness helpers", () => {
  test("isFresherOAuth requires later expires and rejects accountId mismatch", () => {
    const base = {
      type: "oauth" as const,
      access: "a1",
      refresh: "r1",
      expires: 1000,
      accountId: "acc-a",
    };
    expect(
      isFresherOAuth(
        { type: "oauth", access: "a2", refresh: "r2", expires: 2000, accountId: "acc-a" },
        base,
      ),
    ).toBe(true);
    expect(
      isFresherOAuth(
        { type: "oauth", access: "a2", refresh: "r2", expires: 2000, accountId: "acc-b" },
        base,
      ),
    ).toBe(false);
    expect(isFresherOAuth(base, base)).toBe(false);
  });

  test("credentialsEqual compares oauth fields", () => {
    const a = { type: "oauth" as const, access: "a", refresh: "r", expires: 1 };
    expect(credentialsEqual(a, { ...a })).toBe(true);
    expect(credentialsEqual(a, { ...a, access: "b" })).toBe(false);
  });
});
