import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    expect(store.getAccount("xai", "sub")?.availability).toBe("QUOTA_UNKNOWN");
    const resolved = await client.request({
      protocol: 1,
      action: "resolve",
      provider: "xai",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      const data = resolved.data as { profile: string; status: string };
      expect(data.profile).toBe("main");
      expect(data.status).toBe("unavailable");
    }
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(live.xai.access).toBe("main-access");
  });

  test("manual quota poll switches after preferred reaches verified 0%", async () => {
    globalThis.fetch = async (_input, init) => {
      const authorization = init?.headers?.Authorization;
      const used = authorization === "Bearer main-access" ? 100 : 40;
      return new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: used,
            currentPeriod: {
              type: "PERIOD_TYPE_WEEKLY",
              end: "2026-10-01T00:00:00Z",
            },
          },
        }),
        { status: 200 },
      );
    };
    const client = new OarClient({ socketPath });

    const response = await client.request({ protocol: 1, action: "poll-quota" });

    expect(response.ok).toBe(true);
    if (response.ok) {
      const data = response.data as {
        failovers: Array<{ provider: string; from: string; to: string }>;
      };
      expect(data.failovers).toEqual([{ provider: "xai", from: "main", to: "sub" }]);
    }
    expect(store.getProviderPolicy("xai").preferred).toBe("sub");
  });

  test("manual quota poll does not query siblings while preferred stays positive", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const authorization = String(init?.headers?.Authorization ?? "");
      authorizations.push(authorization);
      if (authorization !== "Bearer main-access") {
        throw new Error(`unexpected sibling request: ${authorization}`);
      }
      return new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 20,
            currentPeriod: {
              type: "PERIOD_TYPE_WEEKLY",
              end: "2026-10-01T00:00:00Z",
            },
          },
        }),
        { status: 200 },
      );
    };
    const client = new OarClient({ socketPath });

    const response = await client.request({ protocol: 1, action: "poll-quota" });

    expect(response.ok).toBe(true);
    expect(authorizations).toEqual(["Bearer main-access"]);
    expect(store.getProviderPolicy("xai").preferred).toBe("main");
  });

  test("manual quota poll does not query siblings when preferred quota is unknown", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const authorization = String(init?.headers?.Authorization ?? "");
      authorizations.push(authorization);
      return new Response("unauthorized", { status: 401 });
    };
    const client = new OarClient({ socketPath });

    const response = await client.request({ protocol: 1, action: "poll-quota" });

    expect(response.ok).toBe(true);
    expect(authorizations).toEqual(["Bearer main-access"]);
    expect(store.getProviderPolicy("xai").preferred).toBe("main");
  });

  test("daemon start runs the proactive poll before the first interval", async () => {
    await daemon.stop();
    let signalFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetch = resolve;
    });
    globalThis.fetch = async () => {
      signalFetch?.();
      return new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 20,
            currentPeriod: {
              type: "PERIOD_TYPE_WEEKLY",
              end: "2026-10-01T00:00:00Z",
            },
          },
        }),
        { status: 200 },
      );
    };
    daemon = new OarDaemon({
      store,
      socketPath,
      authPaths: [authPath],
      activateOnUse: true,
      sinks: [],
      quotaPollIntervalMs: 60_000,
    });

    await daemon.start();
    await Promise.race([
      fetchStarted,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("quota poll did not start")), 1_000);
      }),
    ]);

    expect(store.getProviderPolicy("xai").preferred).toBe("main");
  });

  test("stopping the daemon cancels mutations from a pending sibling fetch", async () => {
    let signalSibling: (() => void) | undefined;
    let resolveSibling: ((response: Response) => void) | undefined;
    const siblingStarted = new Promise<void>((resolve) => {
      signalSibling = resolve;
    });
    const siblingResponse = new Promise<Response>((resolve) => {
      resolveSibling = resolve;
    });
    globalThis.fetch = async (_input, init) => {
      const authorization = String(init?.headers?.Authorization ?? "");
      if (authorization === "Bearer main-access") {
        return new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 100,
              currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" },
            },
          }),
          { status: 200 },
        );
      }
      signalSibling?.();
      return siblingResponse;
    };

    const poll = daemon.dispatch({ protocol: 1, action: "poll-quota" });
    await siblingStarted;
    await daemon.stop();
    resolveSibling?.(
      new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 40,
            currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" },
          },
        }),
        { status: 200 },
      ),
    );
    await poll;

    expect(store.getProviderPolicy("xai").preferred).toBe("main");
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(live.xai.access).toBe("main-access");
  });

  test("stopping prevents queued sibling fetches from starting", async () => {
    for (const profile of ["alt-1", "alt-2", "alt-3"]) {
      store.upsertAccount({
        provider: "xai",
        profile,
        auth: "valid",
        availability: "AVAILABLE",
        priority: 100,
        credentialRef: `vault:xai:${profile}`,
      });
      store.putVaultCredential("xai", profile, {
        type: "oauth",
        access: `${profile}-access`,
        refresh: `${profile}-refresh`,
        expires: Date.now() + 3_600_000,
      });
    }
    let signalThreeStarted: (() => void) | undefined;
    const threeStarted = new Promise<void>((resolve) => {
      signalThreeStarted = resolve;
    });
    const pendingResolvers: Array<(response: Response) => void> = [];
    let siblingFetches = 0;
    let queuedFourthFetches = 0;
    globalThis.fetch = async (_input, init) => {
      const authorization = String(init?.headers?.Authorization ?? "");
      if (authorization === "Bearer main-access") {
        return new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 100,
              currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" },
            },
          }),
          { status: 200 },
        );
      }
      siblingFetches += 1;
      if (siblingFetches > 3) {
        queuedFourthFetches += 1;
        return new Response("unexpected queued fetch", { status: 500 });
      }
      if (siblingFetches === 3) signalThreeStarted?.();
      return new Promise<Response>((resolve) => {
        pendingResolvers.push(resolve);
      });
    };

    const poll = daemon.dispatch({ protocol: 1, action: "poll-quota" });
    await threeStarted;
    await daemon.stop();
    for (const resolve of pendingResolvers) {
      resolve(new Response("unauthorized", { status: 401 }));
    }
    await poll;

    expect(siblingFetches).toBe(3);
    expect(queuedFourthFetches).toBe(0);
    expect(store.getProviderPolicy("xai").preferred).toBe("main");
  });

  test("stopping during the preferred fetch preserves state and ends the provider loop", async () => {
    store.upsertAccount({
      provider: "chatgpt-subscription",
      profile: "main",
      auth: "valid",
      availability: "ACTIVE",
      priority: 10,
      credentialRef: "vault:chatgpt-subscription:main",
    });
    store.putVaultCredential("chatgpt-subscription", "main", {
      type: "oauth",
      access: "codex-main-access",
      refresh: "codex-main-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "codex-account",
    });
    store.setPreferred("chatgpt-subscription", "main");
    store.setProviderMode("chatgpt-subscription", "auto");
    store.setAutoFailover("chatgpt-subscription", true);
    let signalPreferred: (() => void) | undefined;
    let resolvePreferred: ((response: Response) => void) | undefined;
    const preferredStarted = new Promise<void>((resolve) => {
      signalPreferred = resolve;
    });
    const preferredResponse = new Promise<Response>((resolve) => {
      resolvePreferred = resolve;
    });
    let laterProviderCalls = 0;
    const mainBefore = store.getAccount("xai", "main")?.availability;
    const subBefore = store.getAccount("xai", "sub")?.availability;
    globalThis.fetch = async (_input, init) => {
      const authorization = String(init?.headers?.Authorization ?? "");
      if (authorization === "Bearer main-access") {
        signalPreferred?.();
        return preferredResponse;
      }
      laterProviderCalls += 1;
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 604800,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const poll = daemon.dispatch({ protocol: 1, action: "poll-quota" });
    await preferredStarted;
    await daemon.stop();
    resolvePreferred?.(
      new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 100,
            currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" },
          },
        }),
        { status: 200 },
      ),
    );
    await poll;

    expect(store.getAccount("xai", "main")?.availability).toBe(mainBefore);
    expect(store.getAccount("xai", "sub")?.availability).toBe(subBefore);
    expect(laterProviderCalls).toBe(0);
    expect(existsSync(join(root, "usage-cache.json"))).toBe(false);
  });

  test("turning auto off cancels a pending sibling failover", async () => {
    let signalSibling: (() => void) | undefined;
    let resolveSibling: ((response: Response) => void) | undefined;
    const siblingStarted = new Promise<void>((resolve) => {
      signalSibling = resolve;
    });
    const siblingResponse = new Promise<Response>((resolve) => {
      resolveSibling = resolve;
    });
    globalThis.fetch = async (_input, init) => {
      const authorization = String(init?.headers?.Authorization ?? "");
      if (authorization === "Bearer main-access") {
        return new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 100,
              currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" },
            },
          }),
          { status: 200 },
        );
      }
      signalSibling?.();
      return siblingResponse;
    };

    const poll = daemon.dispatch({ protocol: 1, action: "poll-quota" });
    await siblingStarted;
    const disabled = await daemon.dispatch({
      protocol: 1,
      action: "auto",
      provider: "xai",
      enabled: false,
    });
    expect(disabled.ok).toBe(true);
    resolveSibling?.(
      new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 40,
            currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" },
          },
        }),
        { status: 200 },
      ),
    );
    await poll;

    expect(store.getProviderPolicy("xai").preferred).toBe("main");
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(live.xai.access).toBe("main-access");
  });

  test("positive remaining quota never fetches siblings even when limitReached is true", async () => {
    await daemon.dispatch({
      protocol: 1,
      action: "auto",
      provider: "xai",
      enabled: false,
    });
    for (const profile of ["main", "sub"]) {
      store.upsertAccount({
        provider: "chatgpt-subscription",
        profile,
        auth: "valid",
        availability: profile === "main" ? "ACTIVE" : "AVAILABLE",
        priority: profile === "main" ? 10 : 20,
        credentialRef: `vault:chatgpt-subscription:${profile}`,
      });
      store.putVaultCredential("chatgpt-subscription", profile, {
        type: "oauth",
        access: `${profile}-codex-access`,
        refresh: `${profile}-codex-refresh`,
        expires: Date.now() + 3_600_000,
        accountId: `${profile}-account`,
      });
    }
    store.setPreferred("chatgpt-subscription", "main");
    store.setProviderMode("chatgpt-subscription", "auto");
    store.setAutoFailover("chatgpt-subscription", true);
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      authorizations.push(String(init?.headers?.Authorization ?? ""));
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 20,
              limit_window_seconds: 604800,
              limit_reached: true,
            },
            limit_reached: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const response = await daemon.dispatch({ protocol: 1, action: "poll-quota" });

    expect(response.ok).toBe(true);
    expect(authorizations).toEqual(["Bearer main-codex-access"]);
    expect(store.getProviderPolicy("chatgpt-subscription").preferred).toBe("main");
  });
});
