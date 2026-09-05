import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthSlotActivator, mergeProviderSlot } from "../src/auth-slot.ts";
import { OarStore } from "../src/store.ts";

describe("mergeProviderSlot", () => {
  const oauth = {
    type: "oauth" as const,
    access: "a1",
    refresh: "r1",
    expires: 100,
    accountId: "acct-1",
  };

  test("keeps native accounts when identity matches", () => {
    const merged = mergeProviderSlot(
      { ...oauth, accounts: { "acct-1": { email: "a@example.com" } }, extra: "keep" },
      oauth,
    );
    expect(merged.accounts).toEqual({ "acct-1": { email: "a@example.com" } });
    expect(merged.extra).toBe("keep");
    expect(merged.access).toBe("a1");
  });

  test("drops accounts when switching to another login", () => {
    const merged = mergeProviderSlot(
      { ...oauth, accounts: { "acct-1": { email: "a@example.com" } } },
      { type: "oauth", access: "a2", refresh: "r2", expires: 200, accountId: "acct-2" },
    );
    expect(merged.accounts).toBeUndefined();
    expect(merged.access).toBe("a2");
    expect(merged.accountId).toBe("acct-2");
  });

  test("fills accountId from live when vault omits it and identity matches", () => {
    const merged = mergeProviderSlot(
      { ...oauth, accounts: { "acct-1": { email: "a@example.com" } } },
      { type: "oauth", access: "a1", refresh: "r1", expires: 100 },
    );
    expect(merged.accountId).toBe("acct-1");
    expect(merged.accounts).toEqual({ "acct-1": { email: "a@example.com" } });
  });
});

describe("writeSlot preserves native multi-account fields", () => {
  let root: string;
  let authPath: string;
  let store: OarStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-merge-"));
    mkdirSync(join(root, "agent"), { recursive: true });
    authPath = join(root, "agent", "auth.json");
    store = new OarStore({ rootDir: join(root, "oar") });
    store.upsertAccount({
      provider: "openai-codex",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 100,
      credentialRef: "vault:openai-codex:main",
    });
    store.putVaultCredential("openai-codex", "main", {
      type: "oauth",
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 3600_000,
      accountId: "acct-1",
    });
    writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: Date.now() + 3600_000,
          accountId: "acct-1",
          accounts: { "acct-1": { email: "dev@example.com" } },
        },
        anthropic: { type: "oauth", access: "ant", refresh: "ant-r", expires: 1 },
      }),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("same-identity activate keeps accounts and other providers", async () => {
    const act = new AuthSlotActivator({ store, authPaths: [authPath], preferSenpiLock: false });
    await act.activate("openai-codex", "main");
    const live = JSON.parse(readFileSync(authPath, "utf8"));
    expect(live["openai-codex"].accounts).toEqual({ "acct-1": { email: "dev@example.com" } });
    expect(live.anthropic.access).toBe("ant");
  });
});
