import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isManualUnreportedUsable, OarRouter } from "../src/router.ts";
import { OarStore } from "../src/store.ts";
import { fetchCodexUsage } from "../src/usage/codex.ts";
import { fetchRemoteUsage } from "../src/usage/fetch.ts";
import { formatUsageTable } from "../src/usage/format.ts";
import { fetchXaiGrokSubscriptionUsage } from "../src/usage/xai-grok.ts";

function unsignedJwt(payload: Record<string, unknown>): string {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${json}.`;
}

describe("remote usage adapters", () => {
  test("codex WHAM maps weekly + session windows to remaining %", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 40,
              limit_window_seconds: 604800,
              reset_at: 2000000000,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_at: 1900000000,
            },
            limit_reached: false,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const usage = await fetchCodexUsage(
      "openai-codex",
      "main",
      {
        type: "oauth",
        access: "tok",
        refresh: "ref",
        expires: Date.now() + 3600_000,
        accountId: "acc",
      },
      { fetchImpl },
    );
    expect(usage.ok).toBe(true);
    const weekly = usage.windows.find((w) => w.kind === "weekly");
    const session = usage.windows.find((w) => w.kind === "session");
    expect(weekly?.remainingPercent).toBe(60);
    expect(session?.remainingPercent).toBe(90);
  });

  test("xai grok billing maps creditUsagePercent", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 25,
            currentPeriod: {
              type: "PERIOD_TYPE_WEEKLY",
              start: "2026-08-10T00:00:00Z",
              end: "2026-08-17T00:00:00Z",
            },
            productUsage: [{ product: "GrokBuild", usagePercent: 25 }],
          },
        }),
        { status: 200 },
      );
    const usage = await fetchXaiGrokSubscriptionUsage(
      "xai",
      "main",
      { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 },
      { fetchImpl },
    );
    expect(usage.ok).toBe(true);
    expect(usage.windows[0]?.remainingPercent).toBe(75);
    expect(usage.windows[0]?.kind).toBe("weekly");
  });

  test("fetchRemoteUsage uses vault + cache without leaking secrets in result", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-usage-"));
    const store = new OarStore({ rootDir: root });
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: "secret-access-token-value",
      refresh: "secret-refresh",
      expires: Date.now() + 3600_000,
    });
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 10,
            currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-08-20T00:00:00Z" },
          },
        }),
        { status: 200 },
      );
    const first = await fetchRemoteUsage(store, "xai", "main", {
      root,
      force: true,
      fetchImpl,
    });
    expect(first.ok).toBe(true);
    expect(JSON.stringify(first)).not.toContain("secret-access");
    // second call hits cache (would fail if fetchImpl required)
    const second = await fetchRemoteUsage(store, "xai", "main", {
      root,
      maxAgeMs: 60_000,
      fetchImpl: async () => {
        throw new Error("should not network");
      },
    });
    expect(second.ok).toBe(true);
    expect(second.windows[0]?.remainingPercent).toBe(90);
  });

  test("forced refresh bypasses a fresh cached auth failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-usage-refresh-"));
    const store = new OarStore({ rootDir: root });
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3600_000,
    });
    const failed = await fetchRemoteUsage(store, "xai", "main", {
      root,
      force: true,
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    expect(failed.ok).toBe(false);

    let calls = 0;
    const refreshed = await fetchRemoteUsage(store, "xai", "main", {
      root,
      force: true,
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 4,
              currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-08-20T00:00:00Z" },
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(calls).toBe(1);
    expect(refreshed.ok).toBe(true);
    expect(refreshed.windows[0]?.remainingPercent).toBe(96);
  });

  test("xai Apple unified billing is authenticated unreported, not 0%", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          config: {
            isUnifiedBillingUser: true,
            onDemandCap: { val: 0 },
            onDemandUsed: { val: 0 },
            prepaidBalance: { val: 0 },
            currentPeriod: {
              type: "PERIOD_TYPE_WEEKLY",
              start: "2026-09-22T00:00:00Z",
              end: "2026-09-29T00:00:00Z",
            },
          },
        }),
        { status: 200 },
      );
    const usage = await fetchXaiGrokSubscriptionUsage(
      "xai",
      "apple",
      { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 },
      { fetchImpl },
    );
    expect(usage.ok).toBe(true);
    expect(usage.windows[0]?.usedPercent).toBeNull();
    expect(usage.windows[0]?.remainingPercent).toBeNull();
    expect(usage.windows[0]?.limitReached).toBe(false);
    expect(usage.extras?.isUnifiedBillingUser).toBe(true);
    expect(usage.extras?.onDemandCap).toBe(0);
    expect(usage.extras?.onDemandUsed).toBe(0);
    expect(usage.extras?.prepaidBalance).toBe(0);
    expect(usage.extras?.unreported).toBe(true);
    expect(usage.extras?.entitlementExhausted).toBe(false);
    expect(formatUsageTable([usage])).toContain("unreported");
    expect(formatUsageTable([usage])).not.toContain("LIMIT");
  });

  test("xai unified on-demand cap maps used/cap to remaining %", async () => {
    const usage = await fetchXaiGrokSubscriptionUsage(
      "xai",
      "unified",
      { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              config: {
                isUnifiedBillingUser: true,
                onDemandCap: { val: 100 },
                onDemandUsed: { val: 25 },
                prepaidBalance: { val: 12.5 },
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(usage.ok).toBe(true);
    expect(usage.windows[0]?.usedPercent).toBe(25);
    expect(usage.windows[0]?.remainingPercent).toBe(75);
    expect(usage.extras?.prepaidBalance).toBe(12.5);
    expect(usage.extras?.unreported).toBe(false);
  });

  test("xai exact zero-cap entitlement is exhausted, not unreported", async () => {
    const usage = await fetchXaiGrokSubscriptionUsage(
      "xai",
      "api",
      { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              config: {
                isUnifiedBillingUser: false,
                onDemandCap: { val: 0 },
                onDemandUsed: { val: 0 },
                prepaidBalance: { val: 0 },
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(usage.ok).toBe(true);
    expect(usage.windows[0]?.remainingPercent).toBe(0);
    expect(usage.windows[0]?.limitReached).toBe(true);
    expect(usage.extras?.unreported).toBe(false);
    expect(usage.extras?.entitlementExhausted).toBe(true);
  });

  test("fetchRemoteUsage Apple payload allows manual use without auto eligibility", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-usage-apple-"));
    const store = new OarStore({ rootDir: root });
    store.upsertAccount({
      provider: "xai",
      profile: "apple",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 10,
      credentialRef: "vault:xai:apple",
    });
    store.upsertAccount({
      provider: "xai",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 20,
      credentialRef: "vault:xai:main",
    });
    store.putVaultCredential("xai", "apple", {
      type: "oauth",
      access: "apple-access",
      refresh: "apple-refresh",
      expires: Date.now() + 3600_000,
    });
    store.setProviderMode("xai", "manual");
    store.setAutoFailover("xai", false);
    store.setPreferred("xai", "main");

    const usage = await fetchRemoteUsage(store, "xai", "apple", {
      root,
      force: true,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            config: {
              isUnifiedBillingUser: true,
              onDemandCap: { val: 0 },
              onDemandUsed: { val: 0 },
              prepaidBalance: { val: 0 },
            },
          }),
          { status: 200 },
        ),
    });
    expect(usage.ok).toBe(true);
    expect(usage.extras?.unreported).toBe(true);
    expect(store.getAccount("xai", "apple")?.availability).toBe("QUOTA_UNKNOWN");
    expect(store.getAccount("xai", "apple")?.reason).toBe("remote_usage_unreported");

    const router = new OarRouter(store);
    store.setProviderMode("xai", "auto");
    store.setAutoFailover("xai", true);
    const auto = router.resolve({ provider: "xai" });
    expect(auto.profile).toBe("main");
    expect(auto.status).toBe("available");

    store.setProviderMode("xai", "manual");
    store.setAutoFailover("xai", false);
    const used = router.use("xai", "apple");
    expect(used.profile).toBe("apple");
    expect(used.status).toBe("available");
    expect(store.getProviderPolicy("xai").preferred).toBe("apple");
    const stuck = router.resolve({ provider: "xai" });
    expect(stuck.profile).toBe("apple");
    expect(stuck.status).toBe("available");
  });

  test("fetchRemoteUsage zero-cap entitlement blocks use without force", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-usage-zerocap-"));
    const store = new OarStore({ rootDir: root });
    store.upsertAccount({
      provider: "xai",
      profile: "api",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 10,
      credentialRef: "vault:xai:api",
    });
    store.putVaultCredential("xai", "api", {
      type: "oauth",
      access: "api-access",
      refresh: "api-refresh",
      expires: Date.now() + 3600_000,
    });
    await fetchRemoteUsage(store, "xai", "api", {
      root,
      force: true,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            config: {
              isUnifiedBillingUser: false,
              onDemandCap: { val: 0 },
              onDemandUsed: { val: 0 },
            },
          }),
          { status: 200 },
        ),
    });
    expect(store.getAccount("xai", "api")?.availability).toBe("QUOTA_EXHAUSTED");
    const router = new OarRouter(store);
    expect(() => router.use("xai", "api")).toThrow(/REFUSED/);
  });

  test("xai 402/403 credit wording is authenticated zero remaining, unrelated 403 is error", async () => {
    const exhausted = await fetchXaiGrokSubscriptionUsage(
      "xai",
      "main",
      { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 },
      {
        fetchImpl: async () =>
          new Response(
            "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/",
            { status: 403 },
          ),
      },
    );
    expect(exhausted.ok).toBe(true);
    expect(exhausted.windows[0]?.label).toBe("grok");
    expect(exhausted.windows[0]?.remainingPercent).toBe(0);
    expect(exhausted.windows[0]?.usedPercent).toBe(100);
    expect(exhausted.windows[0]?.limitReached).toBe(true);
    expect(exhausted.extras?.httpStatus).toBe(403);
    expect(exhausted.extras?.diagnostic).toBe("grok-credits-exhausted");
    expect(exhausted.extras?.entitlementExhausted).toBe(true);
    expect(exhausted.extras?.unreported).toBe(false);

    const paymentRequired = await fetchXaiGrokSubscriptionUsage(
      "xai",
      "main",
      { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 },
      {
        fetchImpl: async () => new Response("supergrok add credits", { status: 402 }),
      },
    );
    expect(paymentRequired.ok).toBe(true);
    expect(paymentRequired.windows[0]?.remainingPercent).toBe(0);
    expect(paymentRequired.extras?.httpStatus).toBe(402);
    expect(paymentRequired.extras?.diagnostic).toBe("grok-credits-exhausted");

    const forbidden = await fetchXaiGrokSubscriptionUsage(
      "xai",
      "main",
      { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 },
      {
        fetchImpl: async () => new Response("ip blocked", { status: 403 }),
      },
    );
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error).toBe("HTTP 403");
    expect(forbidden.windows).toEqual([]);
    expect(forbidden.extras?.httpStatus).toBe(403);
    expect(forbidden.extras?.diagnostic).toBeUndefined();

    const supergrokBlocked = await fetchXaiGrokSubscriptionUsage(
      "xai",
      "main",
      { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3600_000 },
      {
        fetchImpl: async () =>
          new Response("SuperGrok access denied: IP blocked by security policy", { status: 403 }),
      },
    );
    expect(supergrokBlocked.ok).toBe(false);
    expect(supergrokBlocked.error).toBe("HTTP 403");
    expect(supergrokBlocked.extras?.diagnostic).toBeUndefined();
  });

  test("codex derives ChatGPT-Account-Id from idToken and keeps 401 diagnostic", async () => {
    const idToken = unsignedJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-id-token" },
    });
    let seenAccountId: string | undefined;
    const usage = await fetchCodexUsage(
      "openai-codex",
      "main",
      {
        type: "oauth",
        access: "secret-wham-access-token",
        refresh: "secret-wham-refresh",
        expires: Date.now() + 3600_000,
        idToken,
      },
      {
        fetchImpl: async (_url, init) => {
          const headers = new Headers(init?.headers);
          seenAccountId = headers.get("ChatGPT-Account-Id") ?? undefined;
          return new Response("unauthorized", { status: 401 });
        },
      },
    );
    expect(seenAccountId).toBe("acct-from-id-token");
    expect(usage.ok).toBe(false);
    expect(usage.error).toBe("HTTP 401");
    expect(usage.extras?.httpStatus).toBe(401);
    expect(usage.extras?.diagnostic).toBe("chatgpt-wham-unauthorized");
    expect(JSON.stringify(usage)).not.toContain("secret-wham");

    const flatIdToken = unsignedJwt({ chatgpt_account_id: "acct-flat-claim" });
    let seenFlat: string | undefined;
    await fetchCodexUsage(
      "openai-codex",
      "main",
      {
        type: "oauth",
        access: "secret-wham-access-token",
        refresh: "secret-wham-refresh",
        expires: Date.now() + 3600_000,
        idToken: flatIdToken,
      },
      {
        fetchImpl: async (_url, init) => {
          const headers = new Headers(init?.headers);
          seenFlat = headers.get("ChatGPT-Account-Id") ?? undefined;
          return new Response("unauthorized", { status: 401 });
        },
      },
    );
    expect(seenFlat).toBe("acct-flat-claim");
  });

  test("manual use allows only remote_usage_unreported, not arbitrary QUOTA_UNKNOWN", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-usage-manual-"));
    const store = new OarStore({ rootDir: root });
    store.upsertAccount({
      provider: "xai",
      profile: "unreported",
      auth: "valid",
      availability: "QUOTA_UNKNOWN",
      reason: "remote_usage_unreported",
      priority: 10,
      credentialRef: "vault:xai:unreported",
    });
    store.upsertAccount({
      provider: "xai",
      profile: "unknown",
      auth: "valid",
      availability: "QUOTA_UNKNOWN",
      reason: "remote_usage_unknown",
      priority: 20,
      credentialRef: "vault:xai:unknown",
    });
    store.setProviderMode("xai", "manual");
    store.setAutoFailover("xai", false);

    expect(isManualUnreportedUsable(store.getAccount("xai", "unreported")!)).toBe(true);
    expect(isManualUnreportedUsable(store.getAccount("xai", "unknown")!)).toBe(false);

    const router = new OarRouter(store);
    const used = router.use("xai", "unreported");
    expect(used.profile).toBe("unreported");
    expect(used.status).toBe("available");
    expect(() => router.use("xai", "unknown")).toThrow(/REFUSED/);
  });

  test("codex WHAM 401 includes status diagnostics without leaking secrets", async () => {
    const usage = await fetchCodexUsage(
      "openai-codex",
      "main",
      {
        type: "oauth",
        access: "secret-wham-access-token",
        refresh: "secret-wham-refresh",
        expires: Date.now() + 3600_000,
        accountId: "acc-1",
      },
      { fetchImpl: async () => new Response("unauthorized", { status: 401 }) },
    );
    expect(usage.ok).toBe(false);
    expect(usage.source).toBe("codex-wham");
    expect(usage.error).toBe("HTTP 401");
    expect(usage.extras?.httpStatus).toBe(401);
    expect(usage.extras?.diagnostic).toBe("chatgpt-wham-unauthorized");
    expect(JSON.stringify(usage)).not.toContain("secret-wham");

    const root = mkdtempSync(join(tmpdir(), "oar-usage-wham401-"));
    const store = new OarStore({ rootDir: root });
    store.putVaultCredential("openai-codex", "main", {
      type: "oauth",
      access: "secret-wham-access-token",
      refresh: "secret-wham-refresh",
      expires: Date.now() + 3600_000,
      accountId: "acc-1",
    });
    const remote = await fetchRemoteUsage(store, "openai-codex", "main", {
      root,
      force: true,
      applyState: false,
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    expect(remote.ok).toBe(false);
    expect(remote.source).toBe("codex-wham");
    expect(remote.error).toBe("HTTP 401");
    expect(remote.extras?.httpStatus).toBe(401);
    expect(remote.extras?.diagnostic).toBe("chatgpt-wham-unauthorized");
    expect(JSON.stringify(remote)).not.toContain("secret-wham");
  });
});
