import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../src/adapters/index.ts";
import { GenericAdapter } from "../src/adapters/generic.ts";
import { OpenrouterAdapter } from "../src/adapters/openrouter.ts";
import { OarStore } from "../src/store.ts";

describe("Generic adapter (no dedicated adapter / no refresh flow)", () => {
  let root: string;
  let store: OarStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oar-generic-"));
    store = new OarStore({ rootDir: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("createAdapter returns adapters for openrouter, opencode-go, zai-coding-cn, and any unknown provider", () => {
    expect(createAdapter("openrouter", store)).toBeInstanceOf(OpenrouterAdapter);
    expect(createAdapter("opencode-go", store)).toBeInstanceOf(GenericAdapter);
    expect(createAdapter("zai-coding-cn", store)).toBeInstanceOf(GenericAdapter);
    expect(createAdapter("some-future-provider", store)).toBeInstanceOf(GenericAdapter);
  });

  test("has no executeRefresh (never invents a refresh flow)", () => {
    const adapter = createAdapter("opencode-go", store)!;
    expect(adapter.executeRefresh).toBeUndefined();
  });

  test("supportsHotSwitch true, supportsAutoFailover/Concurrent false", () => {
    const adapter = new GenericAdapter("opencode-go", store);
    expect(adapter.supportsHotSwitch()).toBe(true);
    expect(adapter.supportsAutoFailover()).toBe(false);
    expect(adapter.supportsConcurrentAccounts()).toBe(false);
  });

  test("healthCheck: missing vault credential -> REQUIRES_LOGIN", async () => {
    store.upsertAccount({
      provider: "opencode-go",
      profile: "main",
      auth: "unknown",
      availability: "UNKNOWN",
      priority: 1,
      credentialRef: "vault:opencode-go:main",
    });
    const adapter = new GenericAdapter("opencode-go", store);
    const account = store.getAccount("opencode-go", "main")!;
    const health = await adapter.healthCheck(account);
    expect(health.availability).toBe("REQUIRES_LOGIN");
  });

  test("healthCheck: api_key credential present -> AVAILABLE", async () => {
    store.upsertAccount({
      provider: "zai-coding-cn",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 1,
      credentialRef: "vault:zai-coding-cn:main",
    });
    store.putVaultCredential("zai-coding-cn", "main", { type: "api_key", key: "test-key-not-real" });
    const adapter = new GenericAdapter("zai-coding-cn", store);
    const account = store.getAccount("zai-coding-cn", "main")!;
    const health = await adapter.healthCheck(account);
    expect(health.availability).toBe("AVAILABLE");
  });

  test("healthCheck: expired oauth credential -> AUTH_EXPIRED", async () => {
    store.upsertAccount({
      provider: "openrouter",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 1,
      credentialRef: "vault:openrouter:main",
    });
    store.putVaultCredential("openrouter", "main", {
      type: "oauth",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: Date.now() - 1000,
    });
    const adapter = new OpenrouterAdapter(store);
    const account = store.getAccount("openrouter", "main")!;
    const health = await adapter.healthCheck(account);
    expect(health.availability).toBe("AUTH_EXPIRED");
  });

  test("classifyFailure delegates to shared classifier", () => {
    const adapter = new GenericAdapter("opencode-go", store);
    expect(adapter.classifyFailure({ status: 429 })).toBe("RATE_LIMITED");
    expect(adapter.classifyFailure({ status: 401 })).toBe("AUTH_EXPIRED");
  });
});
