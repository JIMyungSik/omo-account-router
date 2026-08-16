import { describe, expect, test } from "bun:test";
import { formatMarkdownTable } from "../src/table.ts";
import { formatUsageTable } from "../src/usage/format.ts";

describe("tables", () => {
  test("formatMarkdownTable aligns columns", () => {
    const out = formatMarkdownTable(
      [
        { key: "a", header: "A" },
        { key: "b", header: "B", align: "right" },
      ],
      [
        { a: "xai", b: "97%" },
        { a: "openai-codex", b: "9%" },
      ],
    );
    expect(out).toContain("| A");
    expect(out).toContain("|---");
    expect(out.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(4);
  });

  test("formatUsageTable renders header and remaining columns", () => {
    const out = formatUsageTable([
      {
        provider: "xai",
        profile: "sub",
        source: "grok-billing",
        fetchedAt: new Date().toISOString(),
        ok: true,
        windows: [
          {
            kind: "weekly",
            usedPercent: 3,
            remainingPercent: 97,
            resetsAt: "2026-08-22T01:32:51.000Z",
            label: "grok",
          },
        ],
      },
      {
        provider: "openai-codex",
        profile: "main",
        source: "codex-wham",
        fetchedAt: new Date().toISOString(),
        ok: true,
        windows: [
          {
            kind: "weekly",
            usedPercent: 91,
            remainingPercent: 9,
            resetsAt: "2026-08-20T03:37:24.000Z",
            label: "week",
          },
        ],
      },
    ]);
    expect(out).toContain("| PROVIDER");
    expect(out).toContain("GROK left");
    expect(out).toContain("97%");
    expect(out).toContain("9%");
  });
});
