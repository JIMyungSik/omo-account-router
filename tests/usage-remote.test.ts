import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarStore } from "../src/store.ts";
import { fetchCodexUsage } from "../src/usage/codex.ts";
import { fetchRemoteUsage } from "../src/usage/fetch.ts";
import { fetchXaiGrokSubscriptionUsage } from "../src/usage/xai-grok.ts";

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
});
