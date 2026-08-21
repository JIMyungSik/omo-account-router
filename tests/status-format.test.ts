import { describe, expect, test } from "bun:test";
import { formatMarkdownTable } from "../src/table.ts";
import {
  buildStatusView,
  formatStatusText,
  isProblematicAccount,
  statusViewToJson,
  type StatusInput,
} from "../src/status-format.ts";
import type { AccountRecord } from "../src/types.ts";

function account(partial: Partial<AccountRecord> & Pick<AccountRecord, "provider" | "profile">): AccountRecord {
  return {
    auth: "valid",
    availability: "AVAILABLE",
    priority: 100,
    credentialRef: "vault:secret-should-not-print",
    ...partial,
  };
}

const sample: StatusInput = {
  accounts: [
    account({
      provider: "xai",
      profile: "sub",
      auth: "expired",
      availability: "AUTH_EXPIRED",
      reason: "token expired",
      until: "2026-08-22T03:00:00.000Z",
    }),
    account({ provider: "xai", profile: "main" }),
    account({
      provider: "openai-codex",
      profile: "work",
      availability: "RATE_LIMITED",
      reason: "retry later",
    }),
    account({ provider: "openai-codex", profile: "main" }),
  ],
  resolvePreview: [
    { provider: "xai", profile: "main", status: "available" },
    { provider: "openai-codex", profile: "main", status: "available" },
  ],
  authPaths: ["/tmp/auth.json"],
  state: {
    providers: {
      xai: { mode: "auto", autoFailover: true, preferred: "main" },
      "openai-codex": { mode: "manual", autoFailover: false, preferred: "main" },
    },
  },
};

describe("status formatter", () => {
  test("sorts by provider, active first, then profile", () => {
    const view = buildStatusView(sample);
    expect(view.rows.map((r) => `${r.provider}:${r.profile}`)).toEqual([
      "openai-codex:main",
      "openai-codex:work",
      "xai:main",
      "xai:sub",
    ]);
    expect(view.rows[0]?.active).toBe(true);
    expect(view.rows[1]?.active).toBe(false);
    expect(view.rows[2]?.active).toBe(true);
    expect(view.rows[3]?.active).toBe(false);
  });

  test("summary counts accounts, active, and problematic", () => {
    const view = buildStatusView(sample);
    expect(view.summary).toEqual({ accounts: 4, active: 2, problematic: 2 });
    expect(isProblematicAccount({ auth: "valid", availability: "QUOTA_EXHAUSTED" })).toBe(true);
    expect(isProblematicAccount({ auth: "revoked", availability: "AVAILABLE" })).toBe(true);
    expect(isProblematicAccount({ auth: "valid", availability: "AVAILABLE" })).toBe(false);
  });

  test("markdown table shape, active mark, legend, auth paths", () => {
    const text = formatStatusText(buildStatusView(sample), { color: false });
    const tableLines = text.split("\n").filter((l) => l.startsWith("|"));
    expect(tableLines[0]).toContain("| PROVIDER");
    expect(tableLines[0]).toContain("| PROFILE");
    expect(tableLines[0]).toContain("| AUTH");
    expect(tableLines[0]).toContain("| STATUS");
    expect(tableLines[0]).toContain("| MODE");
    expect(tableLines[0]).toContain("| AUTO");
    expect(tableLines[0]).toContain("| NOTE");
    expect(tableLines[1]).toMatch(/\|[-: ]+\|/);
    expect(tableLines.length).toBe(6); // header, sep, 4 rows
    expect(text).toContain("accounts 4");
    expect(text).toContain("active 2");
    expect(text).toContain("problematic 2");
    expect(text).toMatch(/\|\s*\*\s+\|/);
    expect(text).toMatch(/\|\s*xai\s+\|\s*main\s+\|/);
    expect(text).toContain("Legend:");
    expect(text).toContain("AUTH");
    expect(text).toContain("STATUS");
    expect(text).toContain("ACTIVE");
    expect(text).toContain("oar panel --refresh");
    expect(text).toContain("/tmp/auth.json");
    expect(text).toContain("token expired");
  });

  test("does not print secrets or credential refs", () => {
    const view = buildStatusView(sample);
    const text = formatStatusText(view, { color: false });
    const json = JSON.stringify(statusViewToJson(view));
    for (const blob of [text, json]) {
      expect(blob.toLowerCase()).not.toContain("access_token");
      expect(blob).not.toContain("sk-");
      expect(blob).not.toContain("vault:secret-should-not-print");
      expect(blob).not.toContain("refresh_token");
    }
  });

  test("json is structured rows + summary", () => {
    const json = statusViewToJson(buildStatusView(sample));
    expect(json.summary.accounts).toBe(4);
    expect(json.rows[0]).toMatchObject({
      active: true,
      provider: "openai-codex",
      profile: "main",
      auth: "valid",
      status: "AVAILABLE",
      mode: "manual",
      auto: false,
    });
    expect(json.authPaths).toEqual(["/tmp/auth.json"]);
  });
});

describe("table ansi width", () => {
  test("colored cells still align", () => {
    const green = "\x1b[32mvalid\x1b[0m";
    const out = formatMarkdownTable(
      [
        { key: "a", header: "AUTH" },
        { key: "b", header: "X" },
      ],
      [{ a: green, b: "1" }],
    );
    const lines = out.split("\n");
    expect(lines[0]?.indexOf("|")).toBe(0);
    expect(lines[2]).toContain(green);
  });
});
