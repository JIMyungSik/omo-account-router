import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCodexAuthFile, createCodexHomeSink, mapCodexAuthFile, resolveCodexAuthPath } from "../src/sinks/codex-home.ts";
import { createDefaultSinks, formatSinkResultLines } from "../src/sinks/index.ts";
import type { OAuthCredential } from "../src/types.ts";

const existingAuth = {
  auth_mode: "apikey",
  OPENAI_API_KEY: "sk-old-not-a-secret",
  tokens: {
    id_token: "id-a",
    access_token: "codex-access-a",
    refresh_token: "codex-refresh-a",
    account_id: "acct-a",
    extra_tok: "keep-if-same",
  },
  last_refresh: "2026-01-01T00:00:00.000Z",
  extra_top: "keep-me",
};

const switched: OAuthCredential = {
  type: "oauth",
  access: "codex-access-b",
  refresh: "codex-refresh-b",
  expires: 1_800_000_000_000,
  accountId: "acct-b",
  idToken: "id-b",
};

describe("Codex home sink", () => {
  let root: string;
  let authPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-codex-"));
    authPath = join(root, "auth.json");
    writeFileSync(authPath, JSON.stringify(existingAuth, null, 2));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("writes chatgpt oauth with the selected account id_token", () => {
    const mapped = mapCodexAuthFile(JSON.parse(readFileSync(authPath, "utf8")), switched);
    const tokens = mapped.tokens as Record<string, unknown>;
    expect(tokens.access_token).toBe("codex-access-b");
    expect(tokens.refresh_token).toBe("codex-refresh-b");
    expect(tokens.account_id).toBe("acct-b");
    expect(tokens.id_token).toBe("id-b");
    expect(tokens.extra_tok).toBeUndefined();
    expect(mapped.auth_mode).toBe("chatgpt");
    expect(mapped.OPENAI_API_KEY).toBeNull();
    expect(mapped.extra_top).toBe("keep-me");
  });

  test("keeps id_token when access+refresh match the same account", () => {
    const same: OAuthCredential = {
      type: "oauth",
      access: "codex-access-a",
      refresh: "codex-refresh-a",
      expires: 1,
      accountId: "acct-a",
    };
    const mapped = mapCodexAuthFile(JSON.parse(readFileSync(authPath, "utf8")), same);
    const tokens = mapped.tokens as Record<string, unknown>;
    expect(tokens.id_token).toBe("id-a");
    expect(tokens.account_id).toBe("acct-a");
    expect(tokens.extra_tok).toBe("keep-if-same");
  });

  test("never inherits a previous account_id on account change", () => {
    const noAccount: OAuthCredential = {
      type: "oauth",
      access: "codex-access-b",
      refresh: "codex-refresh-b",
      expires: 1,
      idToken: "id-b",
    };
    const mapped = mapCodexAuthFile(JSON.parse(readFileSync(authPath, "utf8")), noAccount);
    const tokens = mapped.tokens as Record<string, unknown>;
    expect(tokens.account_id).toBeUndefined();
    expect(tokens.id_token).toBe("id-b");
  });

  test("refuses a switch without id_token and leaves the target byte-for-byte unchanged", () => {
    const before = readFileSync(authPath);
    const sink = createCodexHomeSink({ home: "/nonexistent", env: { OAR_CODEX_AUTH_PATH: authPath } });
    const result = sink.apply({
      type: "oauth",
      access: "codex-access-b",
      refresh: "codex-refresh-b",
      expires: 1,
      accountId: "acct-b",
    });
    expect(result.status).toBe("error");
    expect(result.detail).toBe("missing_id_token");
    expect(readFileSync(authPath)).toEqual(before);
  });

  test("malformed source does not overwrite and omits parse snippets", () => {
    writeFileSync(authPath, "{ not-json secret-fragment-xyz");
    const before = readFileSync(authPath);
    const result = applyCodexAuthFile(authPath, switched);
    expect(result.status).toBe("error");
    expect(result.detail).toBe("invalid_json");
    expect(String(result.detail)).not.toContain("secret-fragment");
    expect(readFileSync(authPath)).toEqual(before);
  });

  test("does not advance last_refresh when reapplying identical credentials", () => {
    writeFileSync(
      authPath,
      JSON.stringify({
        ...existingAuth,
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
      }),
    );
    const before = readFileSync(authPath);
    const same: OAuthCredential = {
      type: "oauth",
      access: "codex-access-a",
      refresh: "codex-refresh-a",
      expires: 1,
      accountId: "acct-a",
      idToken: "id-a",
    };
    const result = applyCodexAuthFile(authPath, same);
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("unchanged");
    expect(readFileSync(authPath)).toEqual(before);
  });

  test("writes CODEX_HOME/auth.json via sink when id_token is present", () => {
    const sink = createCodexHomeSink({
      home: "/nonexistent",
      env: { CODEX_HOME: root },
    });
    const result = sink.apply(switched);
    expect(result.status).toBe("wrote");
    expect(result.path).toBe(authPath);
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      auth_mode: string;
      OPENAI_API_KEY: null;
      tokens: Record<string, string>;
    };
    expect(live.auth_mode).toBe("chatgpt");
    expect(live.OPENAI_API_KEY).toBeNull();
    expect(live.tokens.access_token).toBe("codex-access-b");
    expect(live.tokens.id_token).toBe("id-b");
    expect(live.tokens.account_id).toBe("acct-b");
  });

  test("path precedence is OAR_CODEX_AUTH_PATH > OAR_CODEX_HOME > CODEX_HOME > ~/.codex", () => {
    const override = join(root, "override-auth.json");
    writeFileSync(override, "{}");
    const homeA = join(root, "home-a");
    const homeB = join(root, "home-b");
    const homeDot = join(root, ".codex");
    mkdirSync(homeA, { recursive: true });
    mkdirSync(homeB, { recursive: true });
    mkdirSync(homeDot, { recursive: true });
    writeFileSync(join(homeA, "auth.json"), "{}");
    writeFileSync(join(homeB, "auth.json"), "{}");
    writeFileSync(join(homeDot, "auth.json"), "{}");

    expect(
      resolveCodexAuthPath({
        home: root,
        env: {
          OAR_CODEX_AUTH_PATH: override,
          OAR_CODEX_HOME: homeA,
          CODEX_HOME: homeB,
        },
      }),
    ).toBe(override);
    expect(
      resolveCodexAuthPath({
        home: root,
        env: { OAR_CODEX_HOME: homeA, CODEX_HOME: homeB },
      }),
    ).toBe(join(homeA, "auth.json"));
    expect(resolveCodexAuthPath({ home: root, env: { CODEX_HOME: homeB } })).toBe(join(homeB, "auth.json"));
    expect(resolveCodexAuthPath({ home: root, env: {} })).toBe(join(homeDot, "auth.json"));
  });

  test("missing target is skipped and not created", () => {
    const sink = createCodexHomeSink({
      home: root,
      env: { OAR_CODEX_AUTH_PATH: join(root, "missing.json") },
    });
    expect(sink.apply(switched)).toEqual({
      id: "codex-home",
      status: "skipped",
      detail: "no_codex_auth",
    });
  });

  test("OAR_SINKS=0 disables default sinks", () => {
    expect(createDefaultSinks({ home: root, env: { OAR_SINKS: "0" } })).toEqual([]);
  });

  test("preload OAR_SINKS=0 blocks inherited developer sink paths", () => {
    expect(process.env.OAR_SINKS).toBe("0");
    expect(createDefaultSinks()).toEqual([]);
    expect(
      createDefaultSinks({
        home: "/Users/developer",
        env: {
          ...process.env,
          HOME: "/Users/developer",
          CODEX_HOME: "/Users/developer/.codex",
          OAR_CODEX_HOME: "/Users/developer/.codex",
          OAR_CODEX_AUTH_PATH: "/Users/developer/.codex/auth.json",
          OAR_ARGO_SECRETS_PATH:
            "/Users/developer/Library/Application Support/com.beyondworks.argo/workspaces/.account-secrets-local.json",
        },
      }),
    ).toEqual([]);
  });

  test("fresh env with override paths enables default sinks", () => {
    const sinks = createDefaultSinks({
      home: root,
      env: {
        OAR_CODEX_AUTH_PATH: authPath,
        OAR_ARGO_SECRETS_PATH: join(root, "argo.json"),
      },
    });
    expect(sinks.map((s) => s.id).sort()).toEqual(["argo-grok", "codex-home"]);
  });

  test("formatSinkResultLines prints id/status/path/detail without credential fields", () => {
    const lines = formatSinkResultLines([
      { id: "codex-home", status: "wrote", path: authPath, detail: "chatgpt" },
      { id: "argo-grok", status: "error", detail: "invalid_json" },
    ]);
    expect(lines[0]).toBe(`sink: codex-home wrote ${authPath} chatgpt`);
    expect(lines[1]).toBe("sink: argo-grok error invalid_json");
    expect(lines.join("\n")).not.toContain("id-a");
    expect(lines.join("\n")).not.toContain("sk-");
  });
});
