import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarStore } from "../src/store.ts";
import { buildRecommendations, formatRecommendTable } from "../src/usage/recommend.ts";

describe("recommend ranking", () => {
  test("orders by remaining % and puts exhausted last", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-rec-"));
    const store = new OarStore({ rootDir: root });
    store.upsertAccount({
      provider: "xai",
      profile: "main",
      auth: "valid",
      availability: "QUOTA_EXHAUSTED",
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
    store.upsertAccount({
      provider: "openai-codex",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 100,
      credentialRef: "vault:openai-codex:main",
    });
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: Date.now() + 1e9,
    });
    store.putVaultCredential("xai", "sub", {
      type: "oauth",
      access: "b",
      refresh: "r",
      expires: Date.now() + 1e9,
    });
    store.putVaultCredential("openai-codex", "main", {
      type: "oauth",
      access: "c",
      refresh: "r",
      expires: Date.now() + 1e9,
      accountId: "acc",
    });

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("cli-chat-proxy")) {
        // xai - both hit same; distinguish impossible; return based on call order via body
        return new Response(
          JSON.stringify({
            config: { creditUsagePercent: 5, currentPeriod: { type: "WEEKLY", end: "2026-08-22T00:00:00Z" } },
          }),
          { status: 200 },
        );
      }
      if (url.includes("wham/usage")) {
        return new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 2000000000 },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    };

    // monkey-patch via buildRecommendations force path - need inject fetch
    // Use fetchRemoteUsageForAccounts through module - patch global fetch
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const rows = await buildRecommendations(store, { root, force: true });
      expect(rows.length).toBe(3);
      // exhausted should not be rank 1
      expect(rows[0]?.profile).not.toBe("main");
      const exhausted = rows.find((r) => r.provider === "xai" && r.profile === "main");
      expect(exhausted?.eligibility).toBe("QUOTA_EXHAUSTED");
      expect(exhausted!.rank).toBeGreaterThan(rows[0]!.rank);
      const text = formatRecommendTable(rows);
      expect(text).toContain("RANK");
      expect(text).toContain("top pick:");
      expect(text).toContain("oar use");
    } finally {
      globalThis.fetch = original;
    }
  });
});
