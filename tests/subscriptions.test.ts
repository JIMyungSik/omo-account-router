import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSubscriptionAudit } from "../src/subscriptions/audit.ts";
import { formatAuditText, formatSubscriptionsList } from "../src/subscriptions/format.ts";
import { SubscriptionsStore } from "../src/subscriptions/store.ts";
import { OarStore } from "../src/store.ts";

describe("SubscriptionsStore", () => {
  test("set, list, remove round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-subs-"));
    const store = new SubscriptionsStore({ rootDir: root });
    store.set({ provider: "xai", profile: "main", monthlyUsd: 30, planLabel: "SuperGrok" });
    expect(store.list()).toHaveLength(1);
    expect(store.get("xai", "main")?.monthlyUsd).toBe(30);
    expect(store.remove("xai", "main")).toBe(true);
    expect(store.remove("xai", "main")).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  test("rejects negative monthlyUsd", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-subs-"));
    const store = new SubscriptionsStore({ rootDir: root });
    expect(() => store.set({ provider: "xai", profile: "main", monthlyUsd: -1 })).toThrow(
      /non-negative/,
    );
  });
});

describe("subscription audit", () => {
  test("marks exhausted duplicate as cancel candidate with savings", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-audit-"));
    const oarStore = new OarStore({ rootDir: root });
    const subsStore = new SubscriptionsStore({ rootDir: root });

    oarStore.upsertAccount({
      provider: "xai",
      profile: "main",
      auth: "valid",
      availability: "QUOTA_EXHAUSTED",
      priority: 100,
      credentialRef: "vault:xai:main",
    });
    oarStore.upsertAccount({
      provider: "xai",
      profile: "sub",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 100,
      credentialRef: "vault:xai:sub",
    });
    subsStore.set({ provider: "xai", profile: "main", monthlyUsd: 30, planLabel: "SuperGrok" });
    subsStore.set({ provider: "xai", profile: "sub", monthlyUsd: 30, planLabel: "SuperGrok" });

    const result = await buildSubscriptionAudit(oarStore, subsStore, { root, force: false });
    const main = result.rows.find((r) => r.profile === "main");
    const sub = result.rows.find((r) => r.profile === "sub");
    expect(main?.recommend).toBe("cancel candidate");
    expect(main?.savePerMonth).toBe(30);
    expect(sub?.recommend).toMatch(/keep|demote/);
    expect(result.potentialSavingsUsd).toBe(30);
    expect(result.summary.unsetCost).toEqual([]);
    expect(formatAuditText(result)).toContain("subscription audit");
    expect(formatSubscriptionsList(subsStore.list())).toContain("$30");
  });

  test("unset cost when monthlyUsd missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-audit-"));
    const oarStore = new OarStore({ rootDir: root });
    const subsStore = new SubscriptionsStore({ rootDir: root });
    oarStore.upsertAccount({
      provider: "anthropic",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 100,
      credentialRef: "vault:anthropic:main",
    });
    const result = await buildSubscriptionAudit(oarStore, subsStore, { root, force: false });
    expect(result.rows[0]?.recommend).toBe("unset cost");
    expect(result.summary.unsetCost).toContain("anthropic/main");
  });
});
