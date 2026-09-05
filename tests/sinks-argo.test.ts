import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyArgoGrokSecretFile,
  createArgoGrokSink,
  discoverArgoSecretFiles,
  mapXaiToArgoGrok,
} from "../src/sinks/argo-grok.ts";

const oauth = {
  type: "oauth" as const,
  access: "xai-access",
  refresh: "xai-refresh",
  expires: 1_700_000_000_000,
};

const runnersFixture = {
  runners: {
    codex: { type: "host", value: "auto" },
    grok: { type: "oauth", value: "{\"access_token\":\"old\"}" },
    glm: { type: "apikey", value: "glm-key" },
  },
};

describe("Argo grok sink", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-argo-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("maps vault oauth to access_token/refresh_token/expires_at milliseconds", () => {
    const mapped = mapXaiToArgoGrok(oauth);
    expect(mapped.type).toBe("oauth");
    const value = JSON.parse(mapped.value) as Record<string, unknown>;
    expect(value.access_token).toBe("xai-access");
    expect(value.refresh_token).toBe("xai-refresh");
    expect(value.expires_at).toBe(1_700_000_000_000);
  });

  test("replaces grok and keeps sibling runners", () => {
    const path = join(root, ".secrets.json");
    writeFileSync(path, JSON.stringify(runnersFixture));
    const result = applyArgoGrokSecretFile(path, oauth);
    expect(result.status).toBe("wrote");
    const live = JSON.parse(readFileSync(path, "utf8")) as {
      runners: Record<string, { type: string; value: string }>;
    };
    expect(live.runners.codex).toEqual({ type: "host", value: "auto" });
    expect(live.runners.glm).toEqual({ type: "apikey", value: "glm-key" });
    expect(JSON.parse(live.runners.grok.value)).toEqual({
      access_token: "xai-access",
      refresh_token: "xai-refresh",
      expires_at: 1_700_000_000_000,
    });
  });

  test("skips files without runners.grok", () => {
    const path = join(root, ".secrets.json");
    writeFileSync(path, JSON.stringify({ runners: { glm: { type: "apikey", value: "x" } } }));
    const result = applyArgoGrokSecretFile(path, oauth);
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("no_runners.grok");
  });

  test("createArgoGrokSink writes override path only", () => {
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ runners: { grok: { type: "oauth", value: "{}" } } }));
    const sink = createArgoGrokSink({
      home: root,
      env: { OAR_ARGO_SECRETS_PATH: path },
    });
    const result = sink.apply(oauth);
    expect(result.status).toBe("wrote");
    expect(result.path).toBe(path);
  });

  test("missing override path is skipped", () => {
    const sink = createArgoGrokSink({
      home: root,
      env: { OAR_ARGO_SECRETS_PATH: join(root, "missing.json") },
    });
    expect(sink.apply(oauth)).toEqual({
      id: "argo-grok",
      status: "skipped",
      detail: "no_argo_secrets",
    });
  });

  test("malformed JSON does not overwrite and omits parse snippets", () => {
    const path = join(root, ".secrets.json");
    writeFileSync(path, "{ broken secret-fragment-argo");
    const before = readFileSync(path);
    const result = applyArgoGrokSecretFile(path, oauth);
    expect(result.status).toBe("error");
    expect(result.detail).toBe("invalid_json");
    expect(String(result.detail)).not.toContain("secret-fragment");
    expect(readFileSync(path)).toEqual(before);
  });

  test("partial write keeps error detail and leaves the bad file unchanged", () => {
    const workspaces = join(root, "Library", "Application Support", "com.beyondworks.argo", "workspaces");
    mkdirSync(workspaces, { recursive: true });
    const accountLocal = join(workspaces, ".account-secrets-local.json");
    const wsDir = join(workspaces, "ws-1");
    mkdirSync(wsDir, { recursive: true });
    const wsSecrets = join(wsDir, ".secrets.json");
    writeFileSync(accountLocal, JSON.stringify(runnersFixture));
    writeFileSync(wsSecrets, "{ broken secret-fragment-partial");
    const discovered = createArgoGrokSink({ home: root, env: {} });
    const result = discovered.apply(oauth);
    expect(result.status).toBe("wrote");
    expect(result.path).toContain(accountLocal);
    expect(result.detail).toContain("invalid_json");
    expect(String(result.detail)).not.toContain("secret-fragment");
    expect(JSON.parse(readFileSync(accountLocal, "utf8")).runners.codex).toEqual({
      type: "host",
      value: "auto",
    });
    expect(readFileSync(wsSecrets, "utf8")).toBe("{ broken secret-fragment-partial");
  });

  test("discoverArgoSecretFiles finds account-local and workspace files", () => {
    const workspaces = join(root, "Library", "Application Support", "com.beyondworks.argo", "workspaces");
    mkdirSync(join(workspaces, "ws-a"), { recursive: true });
    const accountLocal = join(workspaces, ".account-secrets-local.json");
    const wsSecrets = join(workspaces, "ws-a", ".secrets.json");
    writeFileSync(accountLocal, "{}");
    writeFileSync(wsSecrets, "{}");
    expect(discoverArgoSecretFiles({ home: root, env: {} }).sort()).toEqual([accountLocal, wsSecrets].sort());
  });
});
