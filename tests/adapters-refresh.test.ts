import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicAdapter } from "../src/adapters/anthropic.ts";
import { OpenaiCodexAdapter } from "../src/adapters/openai-codex.ts";
import { OarStore } from "../src/store.ts";
import type { AccountRecord, OAuthCredential } from "../src/types.ts";

/**
 * Unit tests for OAuth refresh with a mocked global fetch — no real network,
 * no real secrets. Mirrors the pattern already proven for xAI in
 * tests/refresh-lock.test.ts (mocked async refresh).
 */
describe("anthropic + openai-codex OAuth refresh (mocked fetch)", () => {
  let root: string;
  let store: OarStore;
  let originalFetch: typeof fetch;

  const account = (provider: string): AccountRecord => ({
    provider,
    profile: "main",
    auth: "valid",
    availability: "AVAILABLE",
    priority: 1,
    credentialRef: `vault:${provider}:main`,
  });

  const oldCred: OAuthCredential = {
    type: "oauth",
    access: "old-access-not-real",
    refresh: "old-refresh-not-real",
    expires: Date.now() - 1000,
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-refresh-"));
    store = new OarStore({ rootDir: root });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  });

  test("anthropic executeRefresh POSTs to platform.claude.com and returns new oauth credential", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "new-access-not-real",
          refresh_token: "new-refresh-not-real",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const adapter = new AnthropicAdapter(store);
    const result = await adapter.executeRefresh!(account("anthropic"), oldCred);

    expect(capturedUrl).toBe("https://platform.claude.com/v1/oauth/token");
    const parsedBody = JSON.parse(capturedBody);
    expect(parsedBody.grant_type).toBe("refresh_token");
    expect(parsedBody.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(parsedBody.refresh_token).toBe("old-refresh-not-real");

    expect(result.credential.type).toBe("oauth");
    if (result.credential.type === "oauth") {
      expect(result.credential.access).toBe("new-access-not-real");
      expect(result.credential.refresh).toBe("new-refresh-not-real");
      expect(result.credential.expires).toBeGreaterThan(Date.now());
    }
  });

  test("anthropic executeRefresh throws on non-2xx without leaking body into a truthy secret", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), { status: 400 })) as typeof fetch;

    const adapter = new AnthropicAdapter(store);
    await expect(adapter.executeRefresh!(account("anthropic"), oldCred)).rejects.toThrow(/invalid_grant/);
  });

  test("openai-codex executeRefresh POSTs form-encoded to auth.openai.com and preserves accountId", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedContentType = "";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? "");
      capturedContentType = (init?.headers as Record<string, string>)?.["Content-Type"] ?? "";
      return new Response(
        JSON.stringify({
          access_token: "new-codex-access-not-real",
          refresh_token: "new-codex-refresh-not-real",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const credWithAccount: OAuthCredential = { ...oldCred, accountId: "acct-123" };
    const adapter = new OpenaiCodexAdapter(store);
    const result = await adapter.executeRefresh!(account("openai-codex"), credWithAccount);

    expect(capturedUrl).toBe("https://auth.openai.com/oauth/token");
    expect(capturedContentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(params.get("refresh_token")).toBe("old-refresh-not-real");

    expect(result.credential.type).toBe("oauth");
    if (result.credential.type === "oauth") {
      expect(result.credential.access).toBe("new-codex-access-not-real");
      expect(result.credential.accountId).toBe("acct-123");
      expect(result.credential.idToken).toBeUndefined();
    }
  });

  test("openai-codex executeRefresh omits accountId when absent on input credential", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
        { status: 200 },
      )) as typeof fetch;

    const adapter = new OpenaiCodexAdapter(store);
    const result = await adapter.executeRefresh!(account("openai-codex"), oldCred);
    expect(result.credential.type).toBe("oauth");
    if (result.credential.type === "oauth") {
      expect(result.credential.accountId).toBeUndefined();
    }
  });

  test("openai-codex executeRefresh preserves idToken when the response omits it", async () => {
    globalThis.fetch = Object.assign(async () =>
      new Response(
        JSON.stringify({
          access_token: "new-codex-access-not-real",
          refresh_token: "new-codex-refresh-not-real",
          expires_in: 3600,
        }),
        { status: 200 },
      ), { preconnect: globalThis.fetch.preconnect });

    const credWithId: OAuthCredential = {
      ...oldCred,
      accountId: "acct-123",
      idToken: "old-id-token-not-real",
    };
    const adapter = new OpenaiCodexAdapter(store);
    const result = await adapter.executeRefresh!(account("openai-codex"), credWithId);
    expect(result.credential.type).toBe("oauth");
    if (result.credential.type === "oauth") {
      expect(result.credential.idToken).toBe("old-id-token-not-real");
      expect(result.credential.accountId).toBe("acct-123");
    }
  });

  test("openai-codex executeRefresh updates idToken when the response includes it", async () => {
    globalThis.fetch = Object.assign(async () =>
      new Response(
        JSON.stringify({
          access_token: "new-codex-access-not-real",
          refresh_token: "new-codex-refresh-not-real",
          id_token: "new-id-token-not-real",
          expires_in: 3600,
        }),
        { status: 200 },
      ), { preconnect: globalThis.fetch.preconnect });

    const credWithId: OAuthCredential = {
      ...oldCred,
      accountId: "acct-123",
      idToken: "old-id-token-not-real",
    };
    const adapter = new OpenaiCodexAdapter(store);
    const result = await adapter.executeRefresh!(account("openai-codex"), credWithId);
    expect(result.credential.type).toBe("oauth");
    if (result.credential.type === "oauth") {
      expect(result.credential.idToken).toBe("new-id-token-not-real");
    }
  });
});
