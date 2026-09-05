import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarClient } from "../src/client.ts";
import { OarDaemon } from "../src/daemon.ts";
import { createDefaultSinks, formatSinkResultLines } from "../src/sinks/index.ts";
import type { SinkApplyResult } from "../src/sinks/types.ts";
import { OarStore } from "../src/store.ts";
import { fakeCodexTokens } from "../scripts/sink-fixtures.ts";

type SinkRow = { id: string; status: string; path?: string; detail?: string };

describe("sinks through Unix-socket client", () => {
  let root: string;
  let sock: string;
  let authPath: string;
  let codexAuth: string;
  let argoSecrets: string;
  let daemon: OarDaemon;
  let client: OarClient;
  const main = fakeCodexTokens({ accountId: "acct-main", refresh: "ref-main" });
  const sub = fakeCodexTokens({ accountId: "acct-sub", refresh: "ref-sub" });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-sink-int-"));
    sock = join(root, "oar.sock");
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    authPath = join(agentDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        xai: { type: "oauth", access: "xai-live", refresh: "xai-ref", expires: 9_999_999_999_000 },
        anthropic: { type: "oauth", access: "anth-live", refresh: "anth-ref", expires: 9_999_999_999_000 },
      }),
      { mode: 0o600 },
    );

    const codexDir = join(root, "codex");
    mkdirSync(codexDir, { recursive: true });
    codexAuth = join(codexDir, "auth.json");
    writeFileSync(
      codexAuth,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: main.idToken,
          access_token: main.access,
          refresh_token: main.refresh,
          account_id: main.accountId,
        },
        last_refresh: "2026-01-01T00:00:00.000Z",
        extra_top: "keep-me",
      }),
    );

    argoSecrets = join(root, "argo-secrets.json");
    writeFileSync(
      argoSecrets,
      JSON.stringify({
        runners: {
          codex: { type: "host", value: "auto" },
          grok: { type: "oauth", value: "{\"access_token\":\"old-grok\"}" },
          glm: { type: "apikey", value: "glm-key" },
        },
      }),
    );

    const sinkEnv = {
      home: root,
      env: {
        OAR_SINKS: "1",
        OAR_CODEX_AUTH_PATH: codexAuth,
        OAR_ARGO_SECRETS_PATH: argoSecrets,
      },
    };
    const store = new OarStore({ rootDir: root });
    store.upsertAccount({
      provider: "openai-codex",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 1,
      credentialRef: "vault:openai-codex:main",
    });
    store.upsertAccount({
      provider: "openai-codex",
      profile: "sub",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 2,
      credentialRef: "vault:openai-codex:sub",
    });
    store.upsertAccount({
      provider: "xai",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 1,
      credentialRef: "vault:xai:main",
    });
    store.putVaultCredential("openai-codex", "main", {
      type: "oauth",
      access: main.access,
      refresh: main.refresh,
      expires: main.expires,
      accountId: main.accountId,
      idToken: main.idToken,
    });
    store.putVaultCredential("openai-codex", "sub", {
      type: "oauth",
      access: sub.access,
      refresh: sub.refresh,
      expires: sub.expires,
      accountId: sub.accountId,
      idToken: sub.idToken,
    });
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: "xai-access-main",
      refresh: "xai-refresh-main",
      expires: 1_800_000_000_000,
    });

    daemon = new OarDaemon({
      store,
      socketPath: sock,
      authPaths: [authPath],
      sinks: createDefaultSinks(sinkEnv),
    });
    await daemon.start();
    client = new OarClient({ socketPath: sock, retries: 0 });
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("use openai-codex returns sinks and writes that account's id_token", async () => {
    const used = await client.request({
      protocol: 1,
      action: "use",
      provider: "openai-codex",
      profile: "sub",
    });
    expect(used.ok).toBe(true);
    if (!used.ok) return;
    const data = used.data as { sinks?: SinkRow[]; activatedPaths?: string[] };
    expect(Array.isArray(data.sinks)).toBe(true);
    const codex = data.sinks?.find((s) => s.id === "codex-home");
    expect(codex?.status).toBe("wrote");
    expect(codex?.path).toBe(codexAuth);
    expect(data.activatedPaths).toEqual([authPath]);

    const live = JSON.parse(readFileSync(codexAuth, "utf8")) as {
      extra_top: string;
      tokens: Record<string, string>;
    };
    expect(live.tokens.id_token).toBe(sub.idToken);
    expect(live.tokens.account_id).toBe("acct-sub");
    expect(live.extra_top).toBe("keep-me");

    const omo = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { access?: string }>;
    expect(omo.xai.access).toBe("xai-live");
    expect(omo.anthropic.access).toBe("anth-live");
    expect(omo["openai-codex"]?.access).toBe(sub.access);
  });

  test("missing id_token leaves Codex bytes unchanged while OMO activate succeeds", async () => {
    const store = new OarStore({ rootDir: root });
    store.putVaultCredential("openai-codex", "sub", {
      type: "oauth",
      access: "other-access",
      refresh: "other-refresh",
      expires: Date.now() + 60_000,
      accountId: "acct-other",
    });
    const before = readFileSync(codexAuth);
    const used = await client.request({
      protocol: 1,
      action: "use",
      provider: "openai-codex",
      profile: "sub",
    });
    expect(used.ok).toBe(true);
    if (!used.ok) return;
    const sinks = (used.data as { sinks?: SinkRow[] }).sinks ?? [];
    const codex = sinks.find((s) => s.id === "codex-home");
    expect(codex?.status).toBe("error");
    expect(codex?.detail).toBe("missing_id_token");
    expect(readFileSync(codexAuth)).toEqual(before);
    const omo = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { access?: string }>;
    expect(omo["openai-codex"]?.access).toBe("other-access");
    expect(omo.xai.access).toBe("xai-live");
  });

  test("use xai writes Argo grok and keeps sibling runners", async () => {
    const used = await client.request({
      protocol: 1,
      action: "use",
      provider: "xai",
      profile: "main",
    });
    expect(used.ok).toBe(true);
    if (!used.ok) return;
    const sinks = (used.data as { sinks?: SinkRow[] }).sinks ?? [];
    const argo = sinks.find((s) => s.id === "argo-grok");
    expect(argo?.status).toBe("wrote");
    expect(argo?.path).toBe(argoSecrets);
    const live = JSON.parse(readFileSync(argoSecrets, "utf8")) as {
      runners: Record<string, { type: string; value: string }>;
    };
    expect(live.runners.codex).toEqual({ type: "host", value: "auto" });
    expect(live.runners.glm).toEqual({ type: "apikey", value: "glm-key" });
    expect(JSON.parse(live.runners.grok.value)).toEqual({
      access_token: "xai-access-main",
      refresh_token: "xai-refresh-main",
      expires_at: 1_800_000_000_000,
    });
    const omo = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { access?: string }>;
    expect(omo.anthropic.access).toBe("anth-live");
  });

  test("activate JSON exposes sink fields and CLI formatter prints them without secrets", async () => {
    const activated = await client.request({
      protocol: 1,
      action: "activate",
      provider: "xai",
      profile: "main",
    });
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    const payload = activated.data as { sinks?: SinkRow[]; paths?: string[] };
    expect(payload.paths).toEqual([authPath]);
    const argo = payload.sinks?.find((s) => s.id === "argo-grok");
    expect(argo?.status).toBe("wrote");
    expect(argo?.path).toBe(argoSecrets);
    const lines = formatSinkResultLines((payload.sinks ?? []) as SinkApplyResult[]);
    expect(lines.some((line) => line.startsWith("sink: argo-grok wrote "))).toBe(true);
    expect(lines.join("\n")).not.toContain("xai-access-main");
    expect(lines.join("\n")).not.toContain("xai-refresh-main");
  });
});
