import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCodexTokens, nativeCodexAuthJson } from "./sink-fixtures.ts";

const projectRoot = join(import.meta.dir, "..");
const cliJs = join(projectRoot, "dist", "cli.js");
const daemonJs = join(projectRoot, "dist", "daemon-main.js");

if (!existsSync(cliJs) || !existsSync(daemonJs)) {
  throw new Error("dist/cli.js and dist/daemon-main.js required. Run: bun run build");
}

const smoke = join("/tmp", `oar-smoke-sinks-${process.pid}-${Date.now()}`);
const home = join(smoke, "home");
const oarHome = join(smoke, "oar");
const sock = join(smoke, "oar.sock");
const agentDir = join(smoke, "agent");
const omoAuth = join(agentDir, "auth.json");
const nativeMain = join(smoke, "native-main.json");
const nativeSub = join(smoke, "native-sub.json");
const codexDir = join(smoke, "codex");
const codexAuth = join(codexDir, "auth.json");
const argoSecrets = join(smoke, "argo-secrets.json");
mkdirSync(home, { recursive: true });
mkdirSync(oarHome, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(codexDir, { recursive: true });

const main = fakeCodexTokens({ accountId: "acct-main", refresh: "ref-main" });
const sub = fakeCodexTokens({ accountId: "acct-sub", refresh: "ref-sub" });

writeFileSync(
  omoAuth,
  JSON.stringify(
    {
      xai: { type: "oauth", access: "xai-live", refresh: "xai-ref", expires: 9_999_999_999_000 },
      anthropic: { type: "oauth", access: "anth-keep", refresh: "anth-ref", expires: 9_999_999_999_000 },
    },
    null,
    2,
  ),
);
writeFileSync(nativeMain, nativeCodexAuthJson(main));
writeFileSync(nativeSub, nativeCodexAuthJson(sub));
writeFileSync(join(codexDir, "config.toml"), 'cli_auth_credentials_store = "file"\n');
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

const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  OAR_HOME: oarHome,
  OAR_SOCK: sock,
  OAR_AUTH_PATH: omoAuth,
  OAR_CODEX_AUTH_PATH: codexAuth,
  OAR_ARGO_SECRETS_PATH: argoSecrets,
  OAR_SINKS: "1",
};
delete env.OPENAI_API_KEY;
delete env.OPENAI_ACCESS_TOKEN;
delete env.CODEX_API_KEY;
delete env.CHATGPT_API_KEY;
delete env.OAR_ARGO_SINK;
delete env.OAR_CODEX_SINK;

function attachExit(child: ChildProcess, timeoutMs: number, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve(child.exitCode ?? 1);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = () => {
      child.off("close", onClose);
      if (child.exitCode != null || child.signalCode != null) {
        clearTimeout(timer);
        resolve(child.exitCode ?? 1);
      }
    };
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.once("close", onClose);
  });
}

function runNode(args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn("node", args, { env, cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return attachExit(child, timeoutMs, args.join(" ")).then((code) => ({ code, stdout, stderr }));
}

function startDaemon(): Promise<ChildProcess> {
  const child = spawn("node", [daemonJs], { env, cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
        reject(new Error(`daemon ready timeout: ${buf}`));
      });
    }, 15_000);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (/oar-daemon listening/.test(buf)) {
        child.stdout.on("data", () => {});
        child.stderr.on("data", () => {});
        finish(() => resolve(child));
      }
    };
    const onError = (error: Error) => {
      finish(() => reject(error));
    };
    const onExit = (code: number | null) => {
      finish(() => reject(new Error(`daemon exited ${code} before ready: ${buf}`)));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function omo(): Record<string, { access?: string }> {
  return JSON.parse(readFileSync(omoAuth, "utf8")) as Record<string, { access?: string }>;
}

let daemon: ChildProcess | undefined;
let failed = false;

try {
  daemon = await startDaemon();

  const importMain = await runNode([cliJs, "import-auth", "openai-codex", "main", "--from", nativeMain]);
  assert(importMain.code === 0, `import main failed: ${importMain.stderr || importMain.stdout}`);
  const importSub = await runNode([cliJs, "import-auth", "openai-codex", "sub", "--from", nativeSub]);
  assert(importSub.code === 0, `import sub failed: ${importSub.stderr || importSub.stdout}`);
  const importXai = await runNode([cliJs, "import-auth", "xai", "main", "--from", omoAuth]);
  assert(importXai.code === 0, `import xai failed: ${importXai.stderr || importXai.stdout}`);

  const useCodex = await runNode([cliJs, "use", "openai-codex", "sub"]);
  assert(useCodex.code === 0, `use openai-codex failed: ${useCodex.stderr || useCodex.stdout}`);
  assert(useCodex.stdout.includes("sink: codex-home wrote"), `missing wrote sink: ${useCodex.stdout}`);
  assert(useCodex.stdout.includes(codexAuth), `missing path: ${useCodex.stdout}`);
  assert(!useCodex.stdout.includes(sub.idToken), "CLI leaked id token");
  assert(!useCodex.stdout.includes(sub.access), "CLI leaked access token");

  const codexLive = JSON.parse(readFileSync(codexAuth, "utf8")) as {
    auth_mode: string;
    OPENAI_API_KEY: unknown;
    extra_top: string;
    tokens: Record<string, string>;
  };
  assert(codexLive.auth_mode === "chatgpt", "auth_mode");
  assert(codexLive.OPENAI_API_KEY === null, "OPENAI_API_KEY not cleared");
  assert(codexLive.tokens.id_token === sub.idToken, "switched id_token");
  assert(codexLive.tokens.account_id === "acct-sub", "switched account_id");
  assert(codexLive.extra_top === "keep-me", "top-level field dropped");
  assert(omo().anthropic?.access === "anth-keep", "adjacent anthropic slot changed");
  assert(omo().xai?.access === "xai-live", "adjacent xai slot changed");

  const activate = await runNode([cliJs, "activate", "xai", "main"]);
  assert(activate.code === 0, `activate xai failed: ${activate.stderr || activate.stdout}`);
  const activateJson = JSON.parse(activate.stdout) as {
    sinks?: Array<{ id: string; status: string; path?: string }>;
    paths?: string[];
  };
  assert(Array.isArray(activateJson.sinks), "activate.sinks");
  const argo = activateJson.sinks?.find((s) => s.id === "argo-grok");
  assert(argo?.status === "wrote", `argo status ${argo?.status}`);
  assert(argo?.path === argoSecrets, "argo path");
  assert(activateJson.paths?.[0] === omoAuth, "activate paths");

  const argoLive = JSON.parse(readFileSync(argoSecrets, "utf8")) as {
    runners: Record<string, { type: string; value: string }>;
  };
  assert(argoLive.runners.codex.type === "host", "sibling codex");
  assert(argoLive.runners.glm.value === "glm-key", "sibling glm");
  const grok = JSON.parse(argoLive.runners.grok.value) as { access_token: string; expires_at: number };
  assert(grok.access_token === "xai-live", "argo grok token");
  assert(typeof grok.expires_at === "number" && grok.expires_at > 1_000_000_000_000, "expires_at ms");

  const savedCodex = readFileSync(codexAuth);
  rmSync(codexAuth);
  const skipUse = await runNode([cliJs, "use", "openai-codex", "main"]);
  assert(skipUse.code === 0, `use after unlink failed: ${skipUse.stderr}`);
  assert(skipUse.stdout.includes("sink: codex-home skipped"), `expected skip: ${skipUse.stdout}`);
  assert(skipUse.stdout.includes("no_codex_auth"), `expected no_codex_auth: ${skipUse.stdout}`);
  assert(omo().anthropic?.access === "anth-keep", "OMO slot after skip");
  writeFileSync(codexAuth, savedCodex);

  const broken = "{ broken-secret-fragment";
  writeFileSync(codexAuth, broken);
  const badUse = await runNode([cliJs, "use", "openai-codex", "sub"]);
  assert(badUse.code === 0, `use with malformed target failed: ${badUse.stderr}`);
  assert(badUse.stdout.includes("sink: codex-home error"), `expected error: ${badUse.stdout}`);
  assert(badUse.stdout.includes("invalid_json"), `expected invalid_json: ${badUse.stdout}`);
  assert(!badUse.stdout.includes("broken-secret-fragment"), "parse snippet leaked");
  assert(readFileSync(codexAuth, "utf8") === broken, "malformed file overwritten");
  writeFileSync(codexAuth, savedCodex);

  const rewrite = await runNode([cliJs, "use", "openai-codex", "sub"]);
  assert(rewrite.code === 0, rewrite.stderr);
  const restored = JSON.parse(readFileSync(codexAuth, "utf8")) as { tokens: { id_token: string } };
  assert(restored.tokens.id_token === sub.idToken, "restore after malformed");

  const which = spawn("sh", ["-c", "command -v codex"], { stdio: ["ignore", "pipe", "pipe"] });
  const whichOut = { stdout: "", stderr: "" };
  which.stdout.on("data", (c: Buffer) => {
    whichOut.stdout += c.toString("utf8");
  });
  const whichCode = await attachExit(which, 5_000, "command -v codex");
  if (whichCode === 0 && whichOut.stdout.trim()) {
    const loginEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: codexDir,
    };
    const login = spawn("codex", ["-c", 'cli_auth_credentials_store="file"', "login", "status"], {
      env: loginEnv,
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let loginOut = "";
    login.stdout.on("data", (c: Buffer) => {
      loginOut += c.toString("utf8");
    });
    login.stderr.on("data", (c: Buffer) => {
      loginOut += c.toString("utf8");
    });
    const loginCode = await attachExit(login, 15_000, "codex login status");
    const combined = loginOut;
    assert(!/missing field [`']?id_token/.test(combined), `codex missing id_token: ${combined}`);
    assert(!/JWT decoding|invalid jwt|Failed to decode/i.test(combined), `codex JWT error: ${combined}`);
    console.log(
      JSON.stringify({
        codexLoginStatusExit: loginCode,
        codexLoginStatusHasLoggedIn: /logged in|Logged in|account/i.test(combined),
      }),
    );
  } else {
    console.log(JSON.stringify({ codexLoginStatusExit: null, reason: "codex_not_on_path" }));
  }

  console.log(
    JSON.stringify({
      pass: true,
      sinks: ["codex-home", "argo-grok"],
      omoAnthropic: omo().anthropic?.access,
    }),
  );
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  let stopError: unknown;
  if (daemon) {
    const closed = attachExit(daemon, 8_000, "daemon stop");
    if (daemon.exitCode == null && daemon.signalCode == null) daemon.kill("SIGTERM");
    try {
      await closed;
    } catch (error) {
      stopError = error;
      if (daemon.exitCode == null && daemon.signalCode == null) daemon.kill("SIGKILL");
    }
  }
  rmSync(smoke, { recursive: true, force: true });
  if (stopError) {
    failed = true;
    console.error(stopError instanceof Error ? stopError.message : stopError);
    process.exitCode = 1;
  }
}

if (failed) process.exitCode = 1;
