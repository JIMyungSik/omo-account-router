import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthSlotActivator } from "../src/auth-slot.ts";
import { OarStore } from "../src/store.ts";

describe("ensureActivated prevents slot drift", () => {
  let root: string;
  let authPath: string;
  let store: OarStore;

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
      expires: Date.now() + 3600_000,
    });
    store.putVaultCredential("xai", "sub", {
      type: "oauth",
      access: "sub-access",
      refresh: "sub-refresh",
      expires: Date.now() + 3600_000,
    });
    writeFileSync(
      authPath,
      JSON.stringify({ xai: { type: "oauth", access: "main-access", refresh: "main-refresh", expires: 9 } }),
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
});
