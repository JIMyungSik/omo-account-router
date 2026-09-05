import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexHomeSink, mapCodexAuthFile } from "../src/sinks/codex-home.ts";
import { createDefaultSinks } from "../src/sinks/index.ts";

const oauth = {
  type: "oauth" as const,
  access: "codex-access-b",
  refresh: "codex-refresh-b",
  expires: 1_800_000_000_000,
  accountId: "acct-b",
};

describe("Codex home sink", () => {
  let root: string;
  let authPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-codex-"));
    authPath = join(root, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "id-a",
          access_token: "codex-access-a",
          refresh_token: "codex-refresh-a",
          account_id: "acct-a",
        },
        last_refresh: "2026-01-01T00:00:00.000Z",
      }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("drops id_token when switching accounts", () => {
    const mapped = mapCodexAuthFile(JSON.parse(readFileSync(authPath, "utf8")), oauth);
    const tokens = mapped.tokens as Record<string, unknown>;
    expect(tokens.access_token).toBe("codex-access-b");
    expect(tokens.refresh_token).toBe("codex-refresh-b");
    expect(tokens.account_id).toBe("acct-b");
    expect(tokens.id_token).toBeUndefined();
    expect(mapped.auth_mode).toBe("chatgpt");
    expect(mapped.OPENAI_API_KEY).toBeNull();
  });

  test("keeps id_token when access+refresh match", () => {
    const same = {
      type: "oauth" as const,
      access: "codex-access-a",
      refresh: "codex-refresh-a",
      expires: 1,
    };
    const mapped = mapCodexAuthFile(JSON.parse(readFileSync(authPath, "utf8")), same);
    const tokens = mapped.tokens as Record<string, unknown>;
    expect(tokens.id_token).toBe("id-a");
    expect(tokens.account_id).toBe("acct-a");
  });

  test("writes CODEX_HOME/auth.json via sink", () => {
    const sink = createCodexHomeSink({
      home: "/nonexistent",
      env: { CODEX_HOME: root },
    });
    const result = sink.apply(oauth);
    expect(result.status).toBe("wrote");
    expect(result.path).toBe(authPath);
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      tokens: Record<string, string>;
    };
    expect(live.tokens.access_token).toBe("codex-access-b");
  });

  test("OAR_SINKS=0 disables default sinks", () => {
    expect(createDefaultSinks({ home: root, env: { OAR_SINKS: "0" } })).toEqual([]);
  });
});
