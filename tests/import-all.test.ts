import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarClient } from "../src/client.ts";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";
import { importAllFromAuthJson, readAllCredentialsFromAuthJson } from "../src/import-all.ts";

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
      ["anthropic", "openai-codex", "opencode-go", "openrouter", "xai", "zai-coding-cn"].sort(),
    );
    expect(creds.malformed).toBeUndefined();
  });

  test("imports every well-formed provider slot into vault profiles", async () => {
    const result = await importAllFromAuthJson(client, { from: authPath, profile: "main", force: false });

    expect(result.errors).toEqual([]);
    expect(result.imported.sort()).toEqual(
      ["anthropic", "openai-codex", "opencode-go", "openrouter", "xai", "zai-coding-cn"].sort(),
    );

    const accounts = await client.request({ protocol: 1, action: "accounts" });
    expect(accounts.ok).toBe(true);
    if (accounts.ok) {
      const list = accounts.data as Array<{ provider: string; profile: string }>;
      const providers = new Set(list.map((a) => a.provider));
      expect(providers.has("xai")).toBe(true);
      expect(providers.has("anthropic")).toBe(true);
      expect(providers.has("openai-codex")).toBe(true);
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
});
