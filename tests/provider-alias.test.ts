import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCodexProvider, isXaiProvider, resolveProvider } from "../src/provider-alias.ts";
import { OarStore } from "../src/store.ts";

describe("provider aliases", () => {
  test("maps chatgpt and codex names to chatgpt-subscription", () => {
    for (const input of ["openai", "codex", "chatgpt", "openai-codex", "ChatGPT", "chatgpt-subscription"]) {
      expect(resolveProvider(input)).toBe("chatgpt-subscription");
    }
  });

  test("maps grok to xai and leaves other providers unchanged", () => {
    expect(resolveProvider("grok")).toBe("xai");
    expect(resolveProvider("XAI")).toBe("xai");
    expect(resolveProvider("anthropic")).toBe("anthropic");
    expect(isCodexProvider("codex")).toBe(true);
    expect(isXaiProvider("grok")).toBe(true);
  });

  test("load migrates a stored openai-codex account and vault file", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-alias-"));
    const vault = join(root, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(
      join(root, "state.json"),
      JSON.stringify({
        version: 1,
        providers: { "openai-codex": { mode: "manual", autoFailover: false, preferred: "main" } },
        accounts: [
          {
            provider: "openai-codex",
            profile: "main",
            auth: "valid",
            availability: "AVAILABLE",
            priority: 1,
            credentialRef: "vault:openai-codex:main",
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    writeFileSync(join(vault, "openai-codex__main.json"), JSON.stringify({ type: "api_key", key: "k" }));
    try {
      const store = new OarStore({ rootDir: root });
      expect(store.getAccount("codex", "main")?.provider).toBe("chatgpt-subscription");
      expect(store.getProviderPolicy("openai").preferred).toBe("main");
      expect(store.getVaultCredential("chatgpt", "main")?.type).toBe("api_key");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
