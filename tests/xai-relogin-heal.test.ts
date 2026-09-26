import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OarClient } from "../src/client.ts";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function jwt(subject: string, expiresAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: subject, exp: Math.floor(expiresAt / 1000) }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("xAI re-login auto-heal", () => {
  let root: string;
  let socketPath: string;
  let authPath: string;
  let store: OarStore;
  let daemon: OarDaemon;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-xai-relogin-"));
    socketPath = join(root, "oar.sock");
    authPath = join(root, "agent", "auth.json");
    mkdirSync(dirname(authPath), { recursive: true });
    store = new OarStore({ rootDir: root });
    store.upsertAccount({
      provider: "xai",
      profile: "main",
      auth: "valid",
      availability: "AVAILABLE",
      priority: 100,
      credentialRef: "vault:xai:main",
    });
    store.setPreferred("xai", "main");
    daemon = new OarDaemon({
      store,
      socketPath,
      authPaths: [authPath],
      activateOnUse: true,
      sinks: [],
    });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function runStatus(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const script = `
      globalThis.fetch = async (input) => {
        if (String(input) === "https://cli-chat-proxy.grok.com/v1/billing?format=credits") {
          return new Response(JSON.stringify({ config: {
            creditUsagePercent: 10,
            currentPeriod: { type: "PERIOD_TYPE_WEEKLY", end: "2026-10-01T00:00:00Z" }
          } }), { status: 200 });
        }
        throw new Error("unexpected fetch target: " + String(input));
      };
      process.argv = [process.execPath, ${JSON.stringify(cliPath)}, "status"];
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

  test("promotes a newer login slot for the same preferred xAI subject", async () => {
    const now = Date.now();
    const staleAccess = jwt("same-subject", now + 30 * 60_000);
    const freshAccess = jwt("same-subject", now + 3 * 60 * 60_000);
    writeFileSync(
      authPath,
      JSON.stringify({
        xai: {
          type: "oauth",
          access: staleAccess,
          refresh: "revoked-refresh",
          expires: now + 30 * 60_000,
          accounts: [
            {
              name: "default",
              access: staleAccess,
              refresh: "revoked-refresh",
              expires: now + 30 * 60_000,
            },
            {
              name: "login-2",
              access: freshAccess,
              refresh: "fresh-refresh",
              expires: now + 3 * 60 * 60_000,
            },
          ],
        },
      }),
    );
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: jwt("same-subject", now + 60 * 60_000),
      refresh: "vault-refresh",
      expires: now + 60 * 60_000,
    });
    await daemon.start();

    const client = new OarClient({ socketPath });
    const result = await client.request({ protocol: 1, action: "bootstrap-auto" });

    expect(result.ok).toBe(true);
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string; refresh: string; accounts: unknown[] };
    };
    const vault = new OarStore({ rootDir: root }).getVaultCredential("xai", "main");
    expect(live.xai.access).toBe(freshAccess);
    expect(live.xai.refresh).toBe("fresh-refresh");
    expect(live.xai.accounts).toHaveLength(2);
    expect(vault?.type).toBe("oauth");
    if (vault?.type === "oauth") {
      expect(vault.access).toBe(freshAccess);
      expect(vault.refresh).toBe("fresh-refresh");
    }
  });

  test("does not promote a newer login slot for a different xAI subject", async () => {
    const now = Date.now();
    const primaryAccess = jwt("primary-subject", now + 30 * 60_000);
    const otherAccess = jwt("other-subject", now + 3 * 60 * 60_000);
    writeFileSync(
      authPath,
      JSON.stringify({
        xai: {
          type: "oauth",
          access: primaryAccess,
          refresh: "primary-refresh",
          expires: now + 30 * 60_000,
          accounts: [
            {
              name: "default",
              access: primaryAccess,
              refresh: "primary-refresh",
              expires: now + 30 * 60_000,
            },
            {
              name: "login-2",
              access: otherAccess,
              refresh: "other-refresh",
              expires: now + 3 * 60 * 60_000,
            },
          ],
        },
      }),
    );
    store.putVaultCredential("xai", "main", {
      type: "oauth",
      access: jwt("primary-subject", now + 60 * 60_000),
      refresh: "vault-refresh",
      expires: now + 60 * 60_000,
    });
    await daemon.start();

    const result = await runStatus();

    expect(result.exitCode).toBe(0);
    const live = JSON.parse(readFileSync(authPath, "utf8")) as {
      xai: { access: string; refresh: string };
    };
    expect(live.xai.access).toBe(primaryAccess);
    expect(live.xai.refresh).toBe("primary-refresh");
  });
});
