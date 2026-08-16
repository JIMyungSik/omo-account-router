import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarStore } from "../src/store.ts";
import { OarRouter } from "../src/router.ts";

describe("OarRouter resolve/use/report", () => {
  let root: string;
  let store: OarStore;
  let router: OarRouter;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-router-"));
    store = new OarStore({ rootDir: root });
    router = new OarRouter(store);
    store.upsertAccount({
      provider: "xai",
      profile: "account-a",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 10,
      credentialRef: "vault:xai:account-a",
    });
    store.upsertAccount({
      provider: "xai",
      profile: "account-b",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 20,
      credentialRef: "vault:xai:account-b",
    });
    store.setProviderMode("xai", "manual");
    store.setPreferred("xai", "account-a");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("manual preferred account is resolved", () => {
    const r = router.resolve({ provider: "xai" });
    expect(r.profile).toBe("account-a");
    expect(r.status).toBe("available");
  });

  test("use switches preferred account without process restart", () => {
    router.use("xai", "account-b");
    const r = router.resolve({ provider: "xai" });
    expect(r.profile).toBe("account-b");
  });

  test("AUTH_REVOKED removes account from auto candidates", () => {
    store.setProviderMode("xai", "auto");
    router.reportResult({ provider: "xai", account: "account-a", result: "AUTH_REVOKED" });
    const r = router.resolve({ provider: "xai" });
    expect(r.profile).toBe("account-b");
    const a = store.getAccount("xai", "account-a");
    expect(a?.availability).toBe("AUTH_REVOKED");
  });
});
