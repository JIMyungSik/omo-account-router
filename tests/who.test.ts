import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLiveAuth } from "../src/who.ts";
import type { AccountRecord, StoredCredential } from "../src/types.ts";

describe("describeLiveAuth", () => {
  test("names the vault profile sitting in the live slot", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-who-"));
    const auth = join(root, "auth.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      auth,
      JSON.stringify({
        xai: { type: "oauth", access: "live-b", refresh: "ref-b", expires: 1 },
        "chatgpt-subscription": {
          type: "oauth",
          access: "codex-sub",
          refresh: "codex-ref",
          expires: 1,
          accounts: [{ name: "login-4", source: "oauth" }],
        },
      }),
    );
    const accounts: AccountRecord[] = [
      {
        provider: "xai",
        profile: "apple",
        auth: "valid",
        availability: "AVAILABLE",
        priority: 1,
        credentialRef: "vault:xai:apple",
      },
      {
        provider: "chatgpt-subscription",
        profile: "sub",
        auth: "valid",
        availability: "ACTIVE",
        priority: 1,
        credentialRef: "vault:chatgpt-subscription:sub",
        login: "sub@example.com",
      },
    ];
    const vault = new Map<string, StoredCredential>([
      ["xai/apple", { type: "oauth", access: "live-b", refresh: "ref-b", expires: 1 }],
      ["xai/main", { type: "oauth", access: "other", refresh: "other-r", expires: 1 }],
      [
        "chatgpt-subscription/sub",
        { type: "oauth", access: "codex-sub", refresh: "codex-ref", expires: 1 },
      ],
    ]);
    try {
      const rows = describeLiveAuth([auth], accounts, (provider, profile) => vault.get(`${provider}/${profile}`));
      expect(rows.find((row) => row.provider === "xai")).toMatchObject({ profile: "apple", slot: "-" });
      expect(rows.find((row) => row.provider === "chatgpt-subscription")).toMatchObject({
        profile: "sub",
        login: "sub@example.com",
        slot: "-",
        note: "live token",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
