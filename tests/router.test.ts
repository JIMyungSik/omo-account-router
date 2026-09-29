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

  test("use refuses QUOTA_EXHAUSTED account without force", () => {
    router.reportResult({ provider: "xai", account: "account-a", result: "QUOTA_EXHAUSTED" });
    expect(() => router.use("xai", "account-a")).toThrow(/REFUSED/);
    // preferred must not flip to exhausted account
    expect(store.getProviderPolicy("xai").preferred).toBe("account-a");
  });

  test("use --force allows exhausted account", () => {
    router.reportResult({ provider: "xai", account: "account-b", result: "QUOTA_EXHAUSTED" });
    const r = router.use("xai", "account-b", { force: true });
    expect(r.profile).toBe("account-b");
    expect(store.getProviderPolicy("xai").preferred).toBe("account-b");
  });

  test("auto resolve skips QUOTA_EXHAUSTED preferred and picks next", () => {
    store.setProviderMode("xai", "auto");
    store.setAutoFailover("xai", true);
    store.setPreferred("xai", "account-a");
    router.reportResult({ provider: "xai", account: "account-a", result: "QUOTA_EXHAUSTED" });
    const r = router.resolve({ provider: "xai" });
    expect(r.status).toBe("available");
    expect(r.profile).toBe("account-b");
  });

  test("manual mode does not auto-pick another when preferred is exhausted", () => {
    store.setProviderMode("xai", "manual");
    store.setAutoFailover("xai", false);
    store.setPreferred("xai", "account-a");
    router.reportResult({ provider: "xai", account: "account-a", result: "QUOTA_EXHAUSTED" });
    const r = router.resolve({ provider: "xai" });
    expect(r.status).toBe("unavailable");
    expect(r.profile).toBe("account-a");
  });

  test("SUCCESS does not clear QUOTA_EXHAUSTED", () => {
    router.reportResult({ provider: "xai", account: "account-a", result: "QUOTA_EXHAUSTED" });
    router.reportResult({ provider: "xai", account: "account-a", result: "SUCCESS" });
    expect(store.getAccount("xai", "account-a")?.availability).toBe("QUOTA_EXHAUSTED");
  });

  test("SUCCESS does not auto-promote unreported quota", () => {
    store.upsertAccount({
      provider: "xai",
      profile: "account-a",
      auth: "valid",
      availability: "QUOTA_UNKNOWN",
      reason: "remote_usage_unreported",
      priority: 10,
      credentialRef: "vault:xai:account-a",
    });

    router.reportResult({ provider: "xai", account: "account-a", result: "SUCCESS" });

    const account = store.getAccount("xai", "account-a");
    expect(account?.availability).toBe("QUOTA_UNKNOWN");
    expect(account?.reason).toBe("remote_usage_unreported");
  });

  test("manual unreported use requires remote_usage_unreported, not arbitrary QUOTA_UNKNOWN", () => {
    store.upsertAccount({
      provider: "xai",
      profile: "account-a",
      auth: "valid",
      availability: "QUOTA_UNKNOWN",
      reason: "remote_usage_unreported",
      priority: 10,
      credentialRef: "vault:xai:account-a",
    });
    const allowed = router.use("xai", "account-a");
    expect(allowed.profile).toBe("account-a");
    expect(allowed.status).toBe("available");

    store.upsertAccount({
      provider: "xai",
      profile: "account-b",
      auth: "valid",
      availability: "QUOTA_UNKNOWN",
      reason: "remote_usage_unknown",
      priority: 20,
      credentialRef: "vault:xai:account-b",
    });
    expect(() => router.use("xai", "account-b")).toThrow(/REFUSED/);

    store.upsertAccount({
      provider: "xai",
      profile: "account-b",
      auth: "valid",
      availability: "QUOTA_UNKNOWN",
      reason: undefined,
      priority: 20,
      credentialRef: "vault:xai:account-b",
    });
    expect(() => router.use("xai", "account-b")).toThrow(/REFUSED/);
  });

  test("authoritative available quota clears stale QUOTA_EXHAUSTED", () => {
    router.reportResult({ provider: "xai", account: "account-a", result: "QUOTA_EXHAUSTED" });
    router.reportResult({ provider: "xai", account: "account-a", result: "QUOTA_AVAILABLE" });

    const account = store.getAccount("xai", "account-a");
    expect(account?.auth).toBe("valid");
    expect(account?.availability).toBe("AVAILABLE");
    expect(account?.reason).toBeUndefined();
    expect(account?.until).toBeNull();
  });

  test("QUOTA_UNKNOWN report syncs remote_usage_unreported for manual use only", () => {
    router.reportResult({
      provider: "xai",
      account: "account-a",
      result: "QUOTA_UNKNOWN",
      detail: "remote_usage_unreported",
    });
    const account = store.getAccount("xai", "account-a");
    expect(account?.availability).toBe("QUOTA_UNKNOWN");
    expect(account?.reason).toBe("remote_usage_unreported");
    expect(account?.auth).toBe("valid");

    const used = router.use("xai", "account-a");
    expect(used.status).toBe("available");
    expect(used.profile).toBe("account-a");

    store.setProviderMode("xai", "auto");
    store.setAutoFailover("xai", true);
    const auto = router.resolve({ provider: "xai" });
    expect(auto.status).toBe("available");
    expect(auto.profile).toBe("account-b");
  });
});
