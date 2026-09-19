import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAuthStaleHints } from "../src/auth-stale.ts";
import { OarStore } from "../src/store.ts";
import type { StatusRowView } from "../src/status-format.ts";

function row(partial: Partial<StatusRowView> & Pick<StatusRowView, "provider" | "profile">): StatusRowView {
  return {
    active: false,
    auth: "valid",
    availability: "AVAILABLE",
    mode: "manual",
    autoFailover: false,
    preferred: false,
    note: "",
    ...partial,
  };
}

describe("applyAuthStaleHints", () => {
  test("adds hint when oauth access token expired but AUTH still valid", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-stale-"));
    const store = new OarStore({ rootDir: root });
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: Date.now() - 60_000,
    });
    const [updated] = applyAuthStaleHints([row({ provider: "xai", profile: "main" })], store);
    expect(updated?.note).toContain("AUTH may be stale");
    expect(updated?.note).toContain("oar test xai main --live");
  });

  test("adds hint when lastChecked is older than 7 days", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-stale-"));
    const store = new OarStore({ rootDir: root });
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: Date.now() + 1e9,
    });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const [updated] = applyAuthStaleHints(
      [row({ provider: "xai", profile: "main", lastChecked: old })],
      store,
    );
    expect(updated?.note).toContain("AUTH not re-checked recently");
  });

  test("skips non-valid AUTH rows", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-stale-"));
    const store = new OarStore({ rootDir: root });
    const [updated] = applyAuthStaleHints(
      [row({ provider: "xai", profile: "main", auth: "expired" })],
      store,
    );
    expect(updated?.note).toBe("");
  });
});
