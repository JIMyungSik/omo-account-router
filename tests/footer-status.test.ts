import { describe, expect, test } from "bun:test";
import { formatOarUsageStatus } from "../extensions/oar-usage-status.js";

function row(partial: Record<string, unknown>) {
  return {
    provider: "xai",
    profile: "sub",
    active: true,
    remote: undefined,
    ...partial,
  };
}

describe("formatOarUsageStatus", () => {
  test("joins active Grok and Codex remaining percents", () => {
    const text = formatOarUsageStatus({
      rows: [
        row({
          provider: "xai",
          remote: {
            ok: true,
            windows: [{ kind: "weekly", label: "grok", remainingPercent: 40, usedPercent: 60 }],
          },
        }),
        row({
          provider: "openai-codex",
          profile: "sub3",
          remote: {
            ok: true,
            windows: [
              { kind: "session", remainingPercent: 100, usedPercent: 0 },
              { kind: "weekly", remainingPercent: 3, usedPercent: 97 },
            ],
          },
        }),
        row({
          provider: "xai",
          profile: "main",
          active: false,
          remote: {
            ok: true,
            windows: [{ kind: "weekly", label: "grok", remainingPercent: 1, usedPercent: 99 }],
          },
        }),
      ],
    });
    expect(text).toBe("Grok 40% | Codex 5h 100% W 3%");
  });

  test("falls back from usedPercent and marks remote errors", () => {
    const text = formatOarUsageStatus({
      rows: [
        row({
          remote: {
            ok: true,
            windows: [{ kind: "weekly", label: "grok", remainingPercent: null, usedPercent: 25 }],
          },
        }),
        row({
          provider: "openai-codex",
          remote: { ok: false, error: "HTTP 401", windows: [] },
        }),
      ],
    });
    expect(text).toBe("Grok 75% | Codex 5h err W err");
  });

  test("keeps Grok before Codex even when Codex is first in the snapshot", () => {
    const text = formatOarUsageStatus({
      rows: [
        row({
          provider: "openai-codex",
          remote: {
            ok: true,
            windows: [{ kind: "weekly", remainingPercent: 3, usedPercent: 97 }],
          },
        }),
        row({
          remote: {
            ok: true,
            windows: [{ kind: "weekly", label: "grok", remainingPercent: 40, usedPercent: 60 }],
          },
        }),
      ],
    });
    expect(text).toBe("Grok 40% | Codex W 3%");
  });

  test("returns placeholder when no active Grok/Codex rows", () => {
    expect(formatOarUsageStatus(null)).toBe("OAR usage --");
    expect(formatOarUsageStatus({ rows: [] })).toBe("OAR usage --");
    expect(
      formatOarUsageStatus({
        rows: [row({ provider: "anthropic", active: true })],
      }),
    ).toBe("OAR usage --");
  });
});
