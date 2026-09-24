import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("oar use refreshes expired usage credentials safely", () => {
  let root: string;
  let socketPath: string;
  let authPath: string;
  let store: OarStore;
  let daemon: OarDaemon;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-use-refresh-"));
    socketPath = join(root, "oar.sock");
    authPath = join(root, "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(
      authPath,
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "live-old-access",
          refresh: "live-old-refresh",
          expires: Date.now() + 3600_000,
        },
      }),
      { mode: 0o600 },
    );

    store = new OarStore({ rootDir: root });
    store.upsertAccount({
      provider: "xai",
      profile: "main",
      auth: "valid",
      availability: "QUOTA_EXHAUSTED",
      priority: 100,
      credentialRef: "vault:xai:main",
      reason: "remote_usage_grok_0",
    });
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: "vault-expired-access",
      refresh: "vault-refresh",
      expires: Date.now() - 3600_000,
    });

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input) !== "https://auth.x.ai/oauth2/token") {
        throw new Error(`unexpected daemon fetch target: ${String(input)}`);
      }
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          access_token: "vault-fresh-access",
          refresh_token: "vault-fresh-refresh",
          expires_in: 3600,
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
    });
    await daemon.start();
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    globalThis.fetch = originalFetch;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function runUse(usageResponse: "available" | "exhausted" | "unauthorized") {
    const responseCode =
      usageResponse === "unauthorized"
        ? `return new Response("unauthorized", { status: 401 });`
        : `return new Response(JSON.stringify({ config: {
            creditUsagePercent: ${usageResponse === "available" ? "4" : "100"},
            currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" }
          } }), { status: 200 });`;
    const script = `
      globalThis.fetch = async (input) => {
        if (String(input) === "https://cli-chat-proxy.grok.com/v1/billing?format=credits") {
          ${responseCode}
        }
        throw new Error("unexpected CLI fetch target");
      };
      process.argv = [process.execPath, ${JSON.stringify(cliPath)}, "use", "xai", "main"];
      await import(${JSON.stringify(pathToFileURL(cliPath).href)});
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        OAR_HOME: root,
        OAR_SOCK: socketPath,
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

  test("refreshes first, then clears stale quota only after usage confirms availability", async () => {
    const result = await runUse("available");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("is now preferred");
    expect(store.getAccount("xai", "main")?.availability).toBe("ACTIVE");
    const liveAuth = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string; refresh: string };
    };
    expect(liveAuth.xai.access).toBe("vault-fresh-access");
    expect(liveAuth.xai.refresh).toBe("vault-fresh-refresh");
  });

  test("does not activate a refreshed credential when quota is actually exhausted", async () => {
    const result = await runUse("exhausted");

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("remote quota is exhausted (0% remaining)");
    expect(store.getAccount("xai", "main")?.availability).toBe("QUOTA_EXHAUSTED");
    const liveAuth = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string; refresh: string };
    };
    expect(liveAuth.xai.access).toBe("live-old-access");
    expect(liveAuth.xai.refresh).toBe("live-old-refresh");
  });

  test("replaces stale quota with auth-expired when refreshed usage still returns 401", async () => {
    const result = await runUse("unauthorized");

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("HTTP 401");
    expect(store.getAccount("xai", "main")?.auth).toBe("expired");
    expect(store.getAccount("xai", "main")?.availability).toBe("AUTH_EXPIRED");
    const liveAuth = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string };
    };
    expect(liveAuth.xai.access).toBe("live-old-access");
  });
});
