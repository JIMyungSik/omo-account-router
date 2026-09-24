import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarClient } from "../src/client.ts";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";
import {
  importAllFromAuthJson,
  readAllCredentialsFromAuthJson,
  readCredentialFromAuthJson,
} from "../src/import-all.ts";
import { fakeCodexTokens, nativeCodexAuthJson } from "../scripts/sink-fixtures.ts";

describe("import-auth --all", () => {
  let root: string;
  let sock: string;
  let authPath: string;
  let daemon: OarDaemon;
  let client: OarClient;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-import-all-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    authPath = join(agentDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify(
        {
          xai: { type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + 3600_000 },
          anthropic: { type: "oauth", access: "a2", refresh: "r2", expires: Date.now() + 3600_000 },
          "openai-codex": {
            type: "oauth",
            access: "a3",
            refresh: "r3",
            expires: Date.now() + 3600_000,
            accountId: "acct-1",
          },
          openrouter: { type: "oauth", access: "a4", refresh: "r4", expires: Date.now() + 3600_000 },
          "opencode-go": { type: "api_key", key: "k5" },
          "zai-coding-cn": { type: "api_key", key: "k6" },
          malformed: { type: "oauth" }, // missing access/refresh/expires — must be skipped, not thrown
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const sockRoot = join(root, "oar");
    sock = join(sockRoot, "oar.sock");
    const store = new OarStore({ rootDir: sockRoot });
    daemon = new OarDaemon({ store, socketPath: sock, authPaths: [authPath], activateOnUse: false });
    await daemon.start();
    client = new OarClient({ socketPath: sock });
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("readAllCredentialsFromAuthJson skips malformed entries", () => {
    const creds = readAllCredentialsFromAuthJson(authPath);
    expect(Object.keys(creds).sort()).toEqual(
      ["anthropic", "chatgpt-subscription", "opencode-go", "openrouter", "xai", "zai-coding-cn"].sort(),
    );
    expect(creds.malformed).toBeUndefined();
  });

  test("imports every well-formed provider slot into vault profiles", async () => {
    const result = await importAllFromAuthJson(client, { from: authPath, profile: "main", force: false });

    expect(result.errors).toEqual([]);
    expect(result.imported.sort()).toEqual(
      ["anthropic", "chatgpt-subscription", "opencode-go", "openrouter", "xai", "zai-coding-cn"].sort(),
    );

    const accounts = await client.request({ protocol: 1, action: "accounts" });
    expect(accounts.ok).toBe(true);
    if (accounts.ok) {
      const list = accounts.data as Array<{ provider: string; profile: string }>;
      const providers = new Set(list.map((a) => a.provider));
      expect(providers.has("xai")).toBe(true);
      expect(providers.has("anthropic")).toBe(true);
      expect(providers.has("chatgpt-subscription")).toBe(true);
      expect(providers.has("openrouter")).toBe(true);
      expect(providers.has("opencode-go")).toBe(true);
      expect(providers.has("zai-coding-cn")).toBe(true);
    }
  });

  test("does not overwrite an existing vault profile unless --force", async () => {
    // First import establishes xai/main with access "a1".
    await importAllFromAuthJson(client, { from: authPath, profile: "main", force: false });

    // Mutate the source auth.json to a different xai token and re-run without --force.
    const mutated = JSON.parse(
      JSON.stringify({
        xai: { type: "oauth", access: "a1-changed", refresh: "r1-changed", expires: Date.now() + 3600_000 },
      }),
    );
    const authPath2 = join(root, "agent2-auth.json");
    writeFileSync(authPath2, JSON.stringify(mutated, null, 2), { mode: 0o600 });

    const second = await importAllFromAuthJson(client, { from: authPath2, profile: "main", force: false });
    expect(second.skipped).toEqual(["xai"]);
    expect(second.imported).toEqual([]);

    // --force overwrites.
    const third = await importAllFromAuthJson(client, { from: authPath2, profile: "main", force: true });
    expect(third.imported).toEqual(["xai"]);
    expect(third.skipped).toEqual([]);
  });

  test("imports native Codex auth.json including idToken, accountId, and JWT exp", () => {
    const expSec = 1_900_000_000;
    const tokens = fakeCodexTokens({ accountId: "acct-native", expSec });
    const nativePath = join(root, "codex-auth.json");
    writeFileSync(nativePath, nativeCodexAuthJson(tokens), { mode: 0o600 });

    const creds = readAllCredentialsFromAuthJson(nativePath);
    expect(Object.keys(creds)).toEqual(["chatgpt-subscription"]);
    const cred = creds["chatgpt-subscription"];
    expect(cred?.type).toBe("oauth");
    if (cred?.type === "oauth") {
      expect(cred.access).toBe(tokens.access);
      expect(cred.refresh).toBe(tokens.refresh);
      expect(cred.idToken).toBe(tokens.idToken);
      expect(cred.accountId).toBe("acct-native");
      expect(cred.expires).toBe(expSec * 1000);
    }

    const single = readCredentialFromAuthJson(nativePath, "openai-codex");
    expect(single).toEqual(creds["chatgpt-subscription"]);
  });

  test("keeps Senpi openai-codex slots compatible when idToken is present", () => {
    const senpi = {
      "openai-codex": {
        type: "oauth" as const,
        access: "senpi-access",
        refresh: "senpi-refresh",
        expires: 123,
        accountId: "acct-senpi",
        idToken: "senpi-id",
      },
    };
    const senpiPath = join(root, "senpi-auth.json");
    writeFileSync(senpiPath, JSON.stringify(senpi), { mode: 0o600 });
    const cred = readCredentialFromAuthJson(senpiPath, "openai-codex");
    expect(cred).toEqual(senpi["openai-codex"]);
  });

  test("openai-codex import reads chatgpt-subscription when that is the live key", () => {
    const aliasPath = join(root, "alias-auth.json");
    writeFileSync(
      aliasPath,
      JSON.stringify({
        xai: { type: "oauth", access: "xa", refresh: "xr", expires: 1 },
        "chatgpt-subscription": {
          type: "oauth",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: 9,
          accountId: "acct-live",
          idToken: "id-live",
        },
      }),
      { mode: 0o600 },
    );
    const cred = readCredentialFromAuthJson(aliasPath, "openai-codex");
    expect(cred.type === "oauth" && cred.access === "codex-access" && cred.accountId === "acct-live").toBe(true);
    const all = readAllCredentialsFromAuthJson(aliasPath);
    expect(all["chatgpt-subscription"]).toEqual(cred);
    expect(all["openai-codex"]).toBeUndefined();
    expect(all.xai).toBeTruthy();
  });
});
