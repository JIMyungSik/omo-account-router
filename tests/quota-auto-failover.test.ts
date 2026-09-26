import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OarClient } from "../src/client.ts";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("remote quota auto failover", () => {
  let root: string;
  let socketPath: string;
  let authPath: string;
  let store: OarStore;
  let daemon: OarDaemon;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-quota-failover-"));
    socketPath = join(root, "oar.sock");
    authPath = join(root, "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(
      authPath,
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "main-access",
          refresh: "main-refresh",
          expires: Date.now() + 3_600_000,
        },
      }),
    );
    store = new OarStore({ rootDir: root });
    store.upsertAccount({
      provider: "xai",
      profile: "main",
      login: "main@example.com",
      auth: "valid",
      availability: "ACTIVE",
      priority: 100,
      credentialRef: "vault:xai:main",
    });
    store.upsertAccount({
      provider: "xai",
      profile: "sub",
      login: "sub@example.com",
      auth: "valid",
      availability: "QUOTA_EXHAUSTED",
      priority: 100,
      credentialRef: "vault:xai:sub",
      reason: "stale_remote_0",
    });
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: "main-access",
      refresh: "main-refresh",
      expires: Date.now() + 3_600_000,
    });
    store.putVaultCredential("xai", "sub", {
      type: "oauth",
      access: "sub-access",
      refresh: "sub-refresh",
      expires: Date.now() + 3_600_000,
    });
    store.setPreferred("xai", "main");
    store.setProviderMode("xai", "auto");
    store.setAutoFailover("xai", true);
    originalFetch = globalThis.fetch;
    daemon = new OarDaemon({
      store,
      socketPath,
      authPaths: [authPath],
      activateOnUse: true,
      sinks: [],
    });
    await daemon.start();
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    globalThis.fetch = originalFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function runUsage(subResult: "positive" | "unknown" | "zero") {
    const script = `
      globalThis.fetch = async (_input, init) => {
        const authorization = init?.headers?.Authorization || "";
        if (authorization === "Bearer main-access") {
          return new Response(JSON.stringify({ config: {
            creditUsagePercent: 100,
            currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" }
          } }), { status: 200 });
        }
        if (authorization === "Bearer sub-access") {
          ${
            subResult === "positive"
              ? `return new Response(JSON.stringify({ config: {
                  creditUsagePercent: 40,
                  currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" }
                } }), { status: 200 });`
              : subResult === "zero"
                ? `return new Response(JSON.stringify({ config: {
                    creditUsagePercent: 100,
                    currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" }
                  } }), { status: 200 });`
                : `return new Response("unauthorized", { status: 401 });`
          }
        }
        if (authorization === "Bearer alt-access") {
          return new Response(JSON.stringify({ config: {
            creditUsagePercent: 20,
            currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" }
          } }), { status: 200 });
        }
        throw new Error("unexpected authorization");
      };
      process.argv = [process.execPath, ${JSON.stringify(cliPath)}, "usage"];
      await import(${JSON.stringify(pathToFileURL(cliPath).href)});
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        OAR_HOME: root,
        OAR_SOCK: socketPath,
        OAR_AUTH_PATH: authPath,
        OAR_SINKS: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async function runOrder(profiles: readonly string[]) {
    const proc = Bun.spawn(
      [process.execPath, cliPath, "order", "xai", ...profiles],
      {
        env: {
          ...process.env,
          OAR_HOME: root,
          OAR_SOCK: socketPath,
          OAR_AUTH_PATH: authPath,
          OAR_SINKS: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("switches from preferred 0% account to verified positive sibling", async () => {
    const result = await runUsage("positive");

    expect(result.exitCode).toBe(0);
    expect(store.getProviderPolicy("xai").preferred).toBe("sub");
    expect(store.getAccount("xai", "main")?.availability).toBe("QUOTA_EXHAUSTED");
    expect(store.getAccount("xai", "sub")?.availability).toBe("ACTIVE");
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(live.xai.access).toBe("sub-access");
  });

  test("does not switch when sibling remaining quota is unknown", async () => {
    const sub = store.getAccount("xai", "sub");
    expect(sub).toBeDefined();
    if (!sub) throw new Error("sub fixture missing");
    store.upsertAccount({ ...sub, availability: "AVAILABLE", reason: undefined });
    const result = await runUsage("unknown");

    expect(result.exitCode).toBe(0);
    expect(store.getProviderPolicy("xai").preferred).toBe("main");
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(live.xai.access).toBe("main-access");
  });

  test("skips a higher-priority unknown sibling and selects verified positive account", async () => {
    const sub = store.getAccount("xai", "sub");
    expect(sub).toBeDefined();
    if (!sub) throw new Error("sub fixture missing");
    store.upsertAccount({ ...sub, availability: "AVAILABLE", priority: 100, reason: undefined });
    store.upsertAccount({
      provider: "xai",
      profile: "alt",
      login: "alt@example.com",
      auth: "valid",
      availability: "QUOTA_EXHAUSTED",
      priority: 200,
      credentialRef: "vault:xai:alt",
      reason: "stale_remote_0",
    });
    store.putVaultCredential("xai", "alt", {
      type: "oauth",
      access: "alt-access",
      refresh: "alt-refresh",
      expires: Date.now() + 3_600_000,
    });

    const result = await runUsage("unknown");

    expect(result.exitCode).toBe(0);
    expect(store.getProviderPolicy("xai").preferred).toBe("alt");
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(live.xai.access).toBe("alt-access");
  });

  test("skips a higher-priority verified 0% sibling without transient activation", async () => {
    const sub = store.getAccount("xai", "sub");
    expect(sub).toBeDefined();
    if (!sub) throw new Error("sub fixture missing");
    store.upsertAccount({ ...sub, availability: "AVAILABLE", priority: 100, reason: undefined });
    store.upsertAccount({
      provider: "xai",
      profile: "alt",
      login: "alt@example.com",
      auth: "valid",
      availability: "QUOTA_EXHAUSTED",
      priority: 200,
      credentialRef: "vault:xai:alt",
      reason: "stale_remote_0",
    });
    store.putVaultCredential("xai", "alt", {
      type: "oauth",
      access: "alt-access",
      refresh: "alt-refresh",
      expires: Date.now() + 3_600_000,
    });

    const result = await runUsage("zero");

    expect(result.exitCode).toBe(0);
    expect(store.getProviderPolicy("xai").preferred).toBe("alt");
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(live.xai.access).toBe("alt-access");
  });

  test("uses the user-configured order when multiple siblings have positive quota", async () => {
    store.upsertAccount({
      provider: "xai",
      profile: "alt",
      login: "alt@example.com",
      auth: "valid",
      availability: "QUOTA_EXHAUSTED",
      priority: 100,
      credentialRef: "vault:xai:alt",
      reason: "stale_remote_0",
    });
    store.putVaultCredential("xai", "alt", {
      type: "oauth",
      access: "alt-access",
      refresh: "alt-refresh",
      expires: Date.now() + 3_600_000,
    });
    const ordered = await runOrder(["main", "alt", "sub"]);
    expect(ordered.exitCode).toBe(0);
    expect(ordered.stdout).toContain("main -> alt -> sub");

    const result = await runUsage("positive");

    expect(result.exitCode).toBe(0);
    expect(store.getProviderPolicy("xai").preferred).toBe("alt");
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(live.xai.access).toBe("alt-access");
  });

  test("does not fail over when a non-preferred account reports 0%", async () => {
    const sub = store.getAccount("xai", "sub");
    expect(sub).toBeDefined();
    if (!sub) throw new Error("sub fixture missing");
    store.upsertAccount({
      ...sub,
      availability: "AVAILABLE",
      reason: undefined,
    });
    const client = new OarClient({ socketPath });

    const response = await client.request({
      protocol: 1,
      action: "report",
      provider: "xai",
      account: "sub",
      result: "QUOTA_EXHAUSTED",
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      const data = response.data as { failover?: { from: string; to: string } };
      expect(data.failover).toBeUndefined();
    }
    expect(store.getProviderPolicy("xai").preferred).toBe("main");
  });

  test("direct quota report rechecks sibling and rejects HTTP errors", async () => {
    const sub = store.getAccount("xai", "sub");
    expect(sub).toBeDefined();
    if (!sub) throw new Error("sub fixture missing");
    store.upsertAccount({ ...sub, availability: "AVAILABLE", reason: undefined });
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    const client = new OarClient({ socketPath });

    const response = await client.request({
      protocol: 1,
      action: "report",
      provider: "xai",
      account: "main",
      result: "QUOTA_EXHAUSTED",
    });

    expect(response.ok).toBe(true);
    expect(store.getProviderPolicy("xai").preferred).toBe("main");
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(live.xai.access).toBe("main-access");
  });
});
