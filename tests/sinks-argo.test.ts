import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyArgoGrokSecretFile,
  createArgoGrokSink,
  mapXaiToArgoGrok,
} from "../src/sinks/argo-grok.ts";

const oauth = {
  type: "oauth" as const,
  access: "xai-access",
  refresh: "xai-refresh",
  expires: 1_700_000_000_000,
};

describe("Argo grok sink", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-argo-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("maps vault oauth to access_token/refresh_token/expires_at", () => {
    const mapped = mapXaiToArgoGrok(oauth);
    expect(mapped.type).toBe("oauth");
    const value = JSON.parse(mapped.value) as Record<string, unknown>;
    expect(value.access_token).toBe("xai-access");
    expect(value.refresh_token).toBe("xai-refresh");
    expect(value.expires_at).toBe(1_700_000_000_000);
  });

  test("replaces grok and keeps sibling runners", () => {
    const path = join(root, ".secrets.json");
    writeFileSync(
      path,
      JSON.stringify({
        runners: {
          codex: { type: "host", value: "auto" },
          grok: { type: "oauth", value: "{\"access_token\":\"old\"}" },
          glm: { type: "apikey", value: "glm-key" },
        },
      }),
    );
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
    writeFileSync(
      path,
      JSON.stringify({ runners: { grok: { type: "oauth", value: "{}" } } }),
    );
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
});
