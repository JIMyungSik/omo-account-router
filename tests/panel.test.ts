import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateUsage,
  buildPanelSnapshot,
  formatPanelText,
  formatPanelXbar,
  readEventLines,
  type StatusPayload,
} from "../src/panel.ts";

describe("panel aggregation", () => {
  test("readEventLines filters by since and skips bad lines", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-panel-"));
    const path = join(root, "events.jsonl");
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    const neu = new Date().toISOString();
    writeFileSync(
      path,
      [
        "not-json",
        JSON.stringify({ ts: old, event: "report", provider: "xai", profile: "main", reason: "SUCCESS" }),
        JSON.stringify({ ts: neu, event: "report", provider: "xai", profile: "main", reason: "SUCCESS" }),
        JSON.stringify({ ts: neu, event: "report", provider: "xai", profile: "main", reason: "RATE_LIMITED" }),
        JSON.stringify({ ts: neu, event: "use", provider: "xai", profile: "sub", reason: "manual" }),
        "",
      ].join("\n"),
    );
    const since = Date.now() - 24 * 3600_000;
    const lines = readEventLines(path, { sinceMs: since });
    expect(lines.length).toBe(3);
    const usage = aggregateUsage(lines);
    const main = usage.get("xai\0main");
    expect(main?.success).toBe(1);
    expect(main?.rateLimited).toBe(1);
    const sub = usage.get("xai\0sub");
    expect(sub?.switches).toBe(1);
  });

  test("buildPanelSnapshot marks active and formats without secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-panel2-"));
    mkdirSync(root, { recursive: true });
    const eventsPath = join(root, "events.jsonl");
    writeFileSync(
      eventsPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "report",
        provider: "xai",
        profile: "main",
        reason: "SUCCESS",
      }) + "\n",
    );
    const status: StatusPayload = {
      state: {
        version: 1,
        providers: {
          xai: { mode: "auto", autoFailover: true, preferred: "main" },
        },
        accounts: [
          {
            provider: "xai",
            profile: "main",
            auth: "valid",
            availability: "AVAILABLE",
            priority: 100,
            credentialRef: "vault:xai:main",
          },
          {
            provider: "xai",
            profile: "sub",
            auth: "valid",
            availability: "AVAILABLE",
            priority: 100,
            credentialRef: "vault:xai:sub",
          },
        ],
        updatedAt: new Date().toISOString(),
      },
      authPaths: ["/tmp/auth.json"],
      accounts: [
        {
          provider: "xai",
          profile: "main",
          auth: "valid",
          availability: "AVAILABLE",
          priority: 100,
          credentialRef: "vault:xai:main",
        },
        {
          provider: "xai",
          profile: "sub",
          auth: "valid",
          availability: "AVAILABLE",
          priority: 100,
          credentialRef: "vault:xai:sub",
        },
      ],
      resolvePreview: [
        {
          provider: "xai",
          profile: "main",
          status: "available",
          availability: "AVAILABLE",
        },
      ],
      leases: [],
    };
    const snap = buildPanelSnapshot(status, { windowHours: 24, eventsPath });
    expect(snap.rows[0]?.active).toBe(true);
    expect(snap.rows[0]?.profile).toBe("main");
    expect(snap.totals.success).toBe(1);
    const text = formatPanelText(snap);
    expect(text).toContain("xai");
    expect(text).toContain("*");
    expect(text).toContain("PROVIDER");
    expect(text.toLowerCase()).not.toContain("access_token");
    const xbar = formatPanelXbar(snap);
    expect(xbar.startsWith("OAR ")).toBe(true);
    expect(xbar).toContain("param1=use");
  });
});
