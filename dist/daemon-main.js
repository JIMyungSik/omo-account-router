#!/usr/bin/env node
// @bun

// src/daemon.ts
import { chmodSync as chmodSync3, existsSync as existsSync5, mkdirSync as mkdirSync3, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import { createServer } from "node:net";
import { dirname as dirname4 } from "node:path";

// src/classifier.ts
function norm(s) {
  return (s ?? "").toLowerCase();
}
function classifyFailure(input) {
  const body = norm(input.body);
  const code = norm(input.code);
  const status = input.status;
  if (body.includes("invalid_grant") || body.includes("refresh token has been revoked") || body.includes("refresh_token_revoked") || code === "invalid_grant") {
    return "AUTH_REVOKED";
  }
  if (status === 401 || body.includes("unauthorized") || body.includes("token expired") || body.includes("auth_expired")) {
    if (body.includes("revok"))
      return "AUTH_REVOKED";
    return "AUTH_EXPIRED";
  }
  if (status === 429 || body.includes("rate limit") || body.includes("rate_limit")) {
    return "RATE_LIMITED";
  }
  if (status === 402 || body.includes("quota") || body.includes("insufficient_quota") || body.includes("usage limit")) {
    return "QUOTA_EXHAUSTED";
  }
  if (status === 404 || body.includes("model_not_found") || body.includes("model not found")) {
    return "MODEL_NOT_FOUND";
  }
  if (status !== undefined && status >= 500) {
    return "SERVER_ERROR";
  }
  if (status === 400) {
    return "BAD_REQUEST";
  }
  if (status === 422) {
    return "INVALID_ARGUMENT";
  }
  if (body.includes("network") || body.includes("econnreset") || body.includes("fetch failed")) {
    return "NETWORK_ERROR";
  }
  return "UNKNOWN";
}
function isAccountFailoverCandidate(failure) {
  return failure === "AUTH_REVOKED" || failure === "AUTH_EXPIRED" || failure === "RATE_LIMITED" || failure === "QUOTA_EXHAUSTED";
}

// src/adapters/anthropic.ts
var ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
var ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
var REFRESH_SKEW_MS = 5 * 60 * 1000;
var DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

class AnthropicAdapter {
  store;
  provider = "anthropic";
  constructor(store) {
    this.store = store;
  }
  async discoverAccounts() {
    return this.store.listAccounts("anthropic");
  }
  async healthCheck(account) {
    const cred = this.store.getVaultCredential(account.provider, account.profile);
    if (!cred) {
      return { auth: "unknown", availability: "REQUIRES_LOGIN", reason: "missing_vault_credential" };
    }
    if (cred.type === "oauth" && Date.now() >= cred.expires) {
      return { auth: "expired", availability: "AUTH_EXPIRED", reason: "access_expired" };
    }
    return {
      auth: account.auth,
      availability: account.availability === "AUTH_REVOKED" ? "AUTH_REVOKED" : "AVAILABLE"
    };
  }
  async resolveCredential(account) {
    return {
      profile: account.profile,
      ref: account.credentialRef,
      credential: this.store.getVaultCredential(account.provider, account.profile)
    };
  }
  async executeRefresh(_account, credential) {
    if (credential.type !== "oauth") {
      throw new Error("anthropic refresh requires oauth credential");
    }
    const response = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: ANTHROPIC_CLIENT_ID,
        refresh_token: credential.refresh
      })
    });
    let parsed = {};
    try {
      const json = await response.json();
      parsed = json && typeof json === "object" && !Array.isArray(json) ? json : {};
    } catch {
      throw new Error(`anthropic OAuth token refresh failed (HTTP ${response.status}): invalid JSON`);
    }
    if (!response.ok) {
      const error = typeof parsed.error === "string" ? parsed.error : undefined;
      const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined;
      const detail = [error, description].filter(Boolean).join(": ");
      const err = new Error(`anthropic OAuth token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
      err.status = response.status;
      err.body = detail;
      throw err;
    }
    const access = parsed.access_token;
    if (typeof access !== "string" || access.length === 0) {
      throw new Error("Invalid anthropic OAuth response field: access_token");
    }
    const refresh = parsed.refresh_token === undefined ? credential.refresh : parsed.refresh_token;
    if (typeof refresh !== "string" || refresh.length === 0) {
      throw new Error("Invalid anthropic OAuth response field: refresh_token");
    }
    const expiresInSeconds = parsed.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : Number(parsed.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error("Invalid anthropic OAuth response field: expires_in");
    }
    return {
      credential: {
        type: "oauth",
        access,
        refresh,
        expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
        ...credential.accountId ? { accountId: credential.accountId } : {}
      }
    };
  }
  async liveCheck(_account, credential) {
    if (credential.type !== "oauth" && credential.type !== "api_key") {
      return { reachable: false, detail: "unsupported_credential_type" };
    }
    try {
      const response = await fetch("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: credential.type === "oauth" ? { Authorization: `Bearer ${credential.access}`, "anthropic-version": "2023-06-01" } : { "x-api-key": credential.key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(5000)
      });
      return { reachable: true, status: response.status };
    } catch (error) {
      return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  classifyFailure(result) {
    if (result && typeof result === "object") {
      const r = result;
      return classifyFailure({ provider: "anthropic", status: r.status, body: r.body, code: r.code });
    }
    return classifyFailure({ provider: "anthropic", body: String(result) });
  }
  supportsHotSwitch() {
    return true;
  }
  supportsAutoFailover() {
    return false;
  }
  supportsUsageQuery() {
    return false;
  }
  supportsConcurrentAccounts() {
    return false;
  }
}

// src/adapters/generic.ts
class GenericAdapter {
  provider;
  store;
  constructor(provider, store) {
    this.provider = provider;
    this.store = store;
  }
  async discoverAccounts() {
    return this.store.listAccounts(this.provider);
  }
  async healthCheck(account) {
    const cred = this.store.getVaultCredential(account.provider, account.profile);
    if (!cred) {
      return { auth: "unknown", availability: "REQUIRES_LOGIN", reason: "missing_vault_credential" };
    }
    if (cred.type === "oauth" && Date.now() >= cred.expires) {
      return { auth: "expired", availability: "AUTH_EXPIRED", reason: "access_expired" };
    }
    return {
      auth: account.auth,
      availability: account.availability === "AUTH_REVOKED" ? "AUTH_REVOKED" : "AVAILABLE"
    };
  }
  async resolveCredential(account) {
    return {
      profile: account.profile,
      ref: account.credentialRef,
      credential: this.store.getVaultCredential(account.provider, account.profile)
    };
  }
  classifyFailure(result) {
    if (result && typeof result === "object") {
      const r = result;
      return classifyFailure({ provider: this.provider, status: r.status, body: r.body, code: r.code });
    }
    return classifyFailure({ provider: this.provider, body: String(result) });
  }
  supportsHotSwitch() {
    return true;
  }
  supportsAutoFailover() {
    return false;
  }
  supportsUsageQuery() {
    return false;
  }
  supportsConcurrentAccounts() {
    return false;
  }
}

// src/adapters/openai-codex.ts
var CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
var REFRESH_SKEW_MS2 = 5 * 60 * 1000;
var DEFAULT_TOKEN_LIFETIME_SECONDS2 = 3600;

class OpenaiCodexAdapter {
  store;
  provider = "openai-codex";
  constructor(store) {
    this.store = store;
  }
  async discoverAccounts() {
    return this.store.listAccounts("openai-codex");
  }
  async healthCheck(account) {
    const cred = this.store.getVaultCredential(account.provider, account.profile);
    if (!cred) {
      return { auth: "unknown", availability: "REQUIRES_LOGIN", reason: "missing_vault_credential" };
    }
    if (cred.type === "oauth" && Date.now() >= cred.expires) {
      return { auth: "expired", availability: "AUTH_EXPIRED", reason: "access_expired" };
    }
    return {
      auth: account.auth,
      availability: account.availability === "AUTH_REVOKED" ? "AUTH_REVOKED" : "AVAILABLE"
    };
  }
  async resolveCredential(account) {
    return {
      profile: account.profile,
      ref: account.credentialRef,
      credential: this.store.getVaultCredential(account.provider, account.profile)
    };
  }
  async executeRefresh(_account, credential) {
    if (credential.type !== "oauth") {
      throw new Error("openai-codex refresh requires oauth credential");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CODEX_CLIENT_ID
    });
    const response = await fetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    let parsed = {};
    try {
      const json = await response.json();
      parsed = json && typeof json === "object" && !Array.isArray(json) ? json : {};
    } catch {
      throw new Error(`openai-codex OAuth token refresh failed (HTTP ${response.status}): invalid JSON`);
    }
    if (!response.ok) {
      const error = typeof parsed.error === "string" ? parsed.error : undefined;
      const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined;
      const detail = [error, description].filter(Boolean).join(": ");
      const err = new Error(`openai-codex OAuth token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
      err.status = response.status;
      err.body = detail;
      throw err;
    }
    const access = parsed.access_token;
    if (typeof access !== "string" || access.length === 0) {
      throw new Error("Invalid openai-codex OAuth response field: access_token");
    }
    const refresh = parsed.refresh_token === undefined ? credential.refresh : parsed.refresh_token;
    if (typeof refresh !== "string" || refresh.length === 0) {
      throw new Error("Invalid openai-codex OAuth response field: refresh_token");
    }
    const expiresInSeconds = parsed.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS2 : Number(parsed.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error("Invalid openai-codex OAuth response field: expires_in");
    }
    return {
      credential: {
        type: "oauth",
        access,
        refresh,
        expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS2,
        ...credential.accountId ? { accountId: credential.accountId } : {}
      }
    };
  }
  async liveCheck(_account, credential) {
    const token = credential.type === "oauth" ? credential.access : credential.key;
    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      });
      return { reachable: true, status: response.status };
    } catch (error) {
      return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  classifyFailure(result) {
    if (result && typeof result === "object") {
      const r = result;
      return classifyFailure({ provider: "openai-codex", status: r.status, body: r.body, code: r.code });
    }
    return classifyFailure({ provider: "openai-codex", body: String(result) });
  }
  supportsHotSwitch() {
    return true;
  }
  supportsAutoFailover() {
    return false;
  }
  supportsUsageQuery() {
    return false;
  }
  supportsConcurrentAccounts() {
    return false;
  }
}

// src/adapters/openrouter.ts
class OpenrouterAdapter extends GenericAdapter {
  constructor(store) {
    super("openrouter", store);
  }
}

// src/adapters/xai.ts
var XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
var XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
var REFRESH_SKEW_MS3 = 5 * 60 * 1000;
var DEFAULT_TOKEN_LIFETIME_SECONDS3 = 3600;

class XaiAdapter {
  store;
  provider = "xai";
  constructor(store) {
    this.store = store;
  }
  async discoverAccounts() {
    return this.store.listAccounts("xai");
  }
  async healthCheck(account) {
    const cred = this.store.getVaultCredential(account.provider, account.profile);
    if (!cred) {
      return { auth: "unknown", availability: "REQUIRES_LOGIN", reason: "missing_vault_credential" };
    }
    if (cred.type === "oauth" && Date.now() >= cred.expires) {
      return { auth: "expired", availability: "AUTH_EXPIRED", reason: "access_expired" };
    }
    return {
      auth: account.auth,
      availability: account.availability === "AUTH_REVOKED" ? "AUTH_REVOKED" : "AVAILABLE"
    };
  }
  async resolveCredential(account) {
    const credential = this.store.getVaultCredential(account.provider, account.profile);
    return {
      profile: account.profile,
      ref: account.credentialRef,
      credential
    };
  }
  async executeRefresh(account, credential) {
    if (credential.type !== "oauth") {
      throw new Error("xAI refresh requires oauth credential");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_CLIENT_ID,
      refresh_token: credential.refresh
    });
    const response = await fetch(XAI_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    let parsed = {};
    try {
      const json = await response.json();
      parsed = json && typeof json === "object" && !Array.isArray(json) ? json : {};
    } catch {
      throw new Error(`xAI OAuth token refresh failed (HTTP ${response.status}): invalid JSON`);
    }
    if (!response.ok) {
      const error = typeof parsed.error === "string" ? parsed.error : undefined;
      const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined;
      const detail = [error, description].filter(Boolean).join(": ");
      const err = new Error(`xAI OAuth token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
      err.status = response.status;
      err.body = detail;
      throw err;
    }
    const access = parsed.access_token;
    if (typeof access !== "string" || access.length === 0) {
      throw new Error("Invalid xAI OAuth response field: access_token");
    }
    const refresh = parsed.refresh_token === undefined ? credential.refresh : parsed.refresh_token;
    if (typeof refresh !== "string" || refresh.length === 0) {
      throw new Error("Invalid xAI OAuth response field: refresh_token");
    }
    const expiresInSeconds = parsed.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS3 : Number(parsed.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error("Invalid xAI OAuth response field: expires_in");
    }
    return {
      credential: {
        type: "oauth",
        access,
        refresh,
        expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS3
      }
    };
  }
  async liveCheck(_account, credential) {
    const token = credential.type === "oauth" ? credential.access : credential.key;
    try {
      const response = await fetch("https://api.x.ai/v1/models", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      });
      return { reachable: true, status: response.status };
    } catch (error) {
      return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  classifyFailure(result) {
    if (result && typeof result === "object") {
      const r = result;
      return classifyFailure({ provider: "xai", status: r.status, body: r.body, code: r.code });
    }
    return classifyFailure({ provider: "xai", body: String(result) });
  }
  supportsHotSwitch() {
    return true;
  }
  supportsAutoFailover() {
    return false;
  }
  supportsUsageQuery() {
    return false;
  }
  supportsConcurrentAccounts() {
    return false;
  }
}

// src/adapters/index.ts
var KNOWN_GENERIC_PROVIDERS = new Set(["opencode-go", "zai-coding-cn"]);
function createAdapter(provider, store) {
  switch (provider) {
    case "xai":
      return new XaiAdapter(store);
    case "anthropic":
      return new AnthropicAdapter(store);
    case "openai-codex":
      return new OpenaiCodexAdapter(store);
    case "openrouter":
      return new OpenrouterAdapter(store);
    default:
      if (KNOWN_GENERIC_PROVIDERS.has(provider)) {
        return new GenericAdapter(provider, store);
      }
      return new GenericAdapter(provider, store);
  }
}

// src/auth-slot.ts
import {
  chmodSync,
  existsSync as existsSync3,
  mkdirSync,
  readFileSync as readFileSync2,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname as dirname2 } from "node:path";

// src/senpi-install.ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var KNOWN_OMO = "/opt/homebrew/lib/node_modules/omo-ai";
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function fromOmoRoot(omoRoot) {
  const omoPkg = join(omoRoot, "package.json");
  const senpiRoot = join(omoRoot, "node_modules", "@code-yeongyu", "senpi");
  const senpiPkg = join(senpiRoot, "package.json");
  const authStoragePath = join(senpiRoot, "dist", "core", "auth-storage.js");
  const pluginRoot = join(omoRoot, "plugin");
  if (!existsSync(omoPkg) || !existsSync(senpiPkg) || !existsSync(authStoragePath))
    return null;
  const omo = readJson(omoPkg);
  const senpi = readJson(senpiPkg);
  return {
    omoAiVersion: omo.version ?? "unknown",
    senpiVersion: senpi.version ?? "unknown",
    omoAiRoot: omoRoot,
    senpiRoot,
    authStoragePath,
    pluginRoot
  };
}
function findSenpiInstall() {
  const require2 = createRequire(import.meta.url);
  const candidates = [];
  try {
    candidates.push(dirname(require2.resolve("omo-ai/package.json")));
  } catch {}
  candidates.push(KNOWN_OMO);
  const homebrew = join(homedir(), ".nvm", "versions");
  if (existsSync(homebrew)) {}
  for (const root of candidates) {
    const found = fromOmoRoot(root);
    if (found)
      return found;
  }
  return null;
}

// src/senpi-auth.ts
var cached;
async function loadSenpiAuthStorageClass() {
  if (cached !== undefined)
    return cached;
  const install = findSenpiInstall();
  if (!install) {
    cached = null;
    return null;
  }
  try {
    const mod = await import(install.authStoragePath);
    if (!mod.AuthStorage?.create) {
      cached = null;
      return null;
    }
    cached = mod.AuthStorage;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}
async function createSenpiAuthStorage(authPath) {
  const ctor = await loadSenpiAuthStorageClass();
  if (!ctor)
    return null;
  return ctor.create(authPath);
}

// src/paths.ts
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function defaultOarRoot(env = process.env) {
  if (env.OAR_HOME)
    return env.OAR_HOME;
  return join2(homedir2(), ".oar");
}
function oarStatePath(root = defaultOarRoot()) {
  return join2(root, "state.json");
}
function oarVaultDir(root = defaultOarRoot()) {
  return join2(root, "vault");
}
function oarEventsPath(root = defaultOarRoot()) {
  return join2(root, "events.jsonl");
}
function unique(paths) {
  const out = [];
  for (const p of paths) {
    if (!out.includes(p))
      out.push(p);
  }
  return out;
}
function resolveActiveAuthPaths(env = process.env, home = homedir2()) {
  const envDirs = [
    env.OAR_AUTH_DIR,
    env.OMO_CODING_AGENT_DIR,
    env.SENPI_CODING_AGENT_DIR,
    env.PI_CODING_AGENT_DIR
  ].filter((v) => typeof v === "string" && v.length > 0);
  if (env.OAR_AUTH_PATH)
    return unique([env.OAR_AUTH_PATH]);
  if (envDirs.length > 0)
    return unique(envDirs.map((dir) => join2(dir, "auth.json")));
  const known = knownAuthJsonCandidates(home);
  if (env.OAR_ACTIVATE_ALL === "1") {
    const existing = known.filter((p) => existsSync2(p));
    return existing.length > 0 ? existing : [known[0]];
  }
  const omoAgent = join2(home, ".omo", "agent", "auth.json");
  if (existsSync2(omoAgent) || existsSync2(join2(home, ".omo")))
    return [omoAgent];
  return [join2(home, ".senpi", "agent", "auth.json")];
}
function knownAuthJsonCandidates(home) {
  return unique([
    join2(home, ".omo", "agent", "auth.json"),
    join2(home, ".omo", "auth.json"),
    join2(home, ".senpi", "agent", "auth.json")
  ]);
}

// src/auth-slot.ts
class AuthSlotActivator {
  store;
  authPaths;
  preferSenpiLock;
  constructor(opts) {
    this.store = opts.store;
    this.authPaths = opts.authPaths ?? resolveActiveAuthPaths();
    this.preferSenpiLock = opts.preferSenpiLock ?? true;
  }
  getAuthPaths() {
    return [...this.authPaths];
  }
  async activate(provider, profile) {
    const cred = this.store.getVaultCredential(provider, profile);
    if (!cred) {
      throw new Error(`No vault credential for ${provider}/${profile}`);
    }
    const written = [];
    let via = "atomic-rename";
    for (const path of this.authPaths) {
      const usedSenpi = this.preferSenpiLock ? await this.writeSlotViaSenpi(path, provider, cred) : false;
      if (!usedSenpi)
        this.writeSlot(path, provider, cred);
      else
        via = "senpi-auth-storage";
      written.push(path);
    }
    const account = this.store.getAccount(provider, profile);
    if (account) {
      this.store.upsertAccount({
        ...account,
        lastUsedAt: new Date().toISOString(),
        availability: "ACTIVE"
      });
    }
    return { paths: written, via };
  }
  async writeSlotViaSenpi(authPath, provider, credential) {
    try {
      const storage = await createSenpiAuthStorage(authPath);
      if (!storage)
        return false;
      await storage.modify(provider, async () => credential);
      return true;
    } catch {
      return false;
    }
  }
  writeSlot(authPath, provider, credential) {
    mkdirSync(dirname2(authPath), { recursive: true, mode: 448 });
    let data = {};
    if (existsSync3(authPath)) {
      try {
        data = JSON.parse(readFileSync2(authPath, "utf8"));
      } catch {
        data = {};
      }
    }
    data[provider] = credential;
    const tmp = `${authPath}.oar.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 384 });
    renameSync(tmp, authPath);
    try {
      chmodSync(authPath, 384);
    } catch {}
  }
}

// src/events.ts
import { appendFileSync, chmodSync as chmodSync2, existsSync as existsSync4, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname3 } from "node:path";
var SECRET_KEYS = /access|refresh|token|authorization|api[_-]?key|secret|password/i;
function scrub(value) {
  if (value == null)
    return value;
  if (typeof value === "string") {
    if (value.length > 24 && SECRET_KEYS.test(value))
      return "[redacted]";
    return value;
  }
  if (Array.isArray(value))
    return value.map(scrub);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(v);
    }
    return out;
  }
  return value;
}

class EventLog {
  path;
  constructor(path) {
    this.path = path;
  }
  static forRoot(root) {
    return new EventLog(oarEventsPath(root));
  }
  append(event) {
    mkdirSync2(dirname3(this.path), { recursive: true, mode: 448 });
    const line = JSON.stringify(scrub({ ...event, ts: event.ts || new Date().toISOString() })) + `
`;
    const existed = existsSync4(this.path);
    appendFileSync(this.path, line, { encoding: "utf8", mode: 384 });
    if (!existed) {
      try {
        chmodSync2(this.path, 384);
      } catch {}
    }
  }
}

// src/lease.ts
import { randomUUID } from "node:crypto";

class LeaseManager {
  leases = new Map;
  list(provider, profile) {
    return [...this.leases.values()].filter((l) => {
      if (provider && l.provider !== provider)
        return false;
      if (profile && l.profile !== profile)
        return false;
      return true;
    });
  }
  count(provider, profile) {
    return this.list(provider, profile).length;
  }
  acquire(opts) {
    const holders = this.count(opts.provider, opts.profile);
    if (opts.maxConcurrent !== undefined && holders >= opts.maxConcurrent) {
      return {
        ok: false,
        queued: true,
        reason: "max_concurrent",
        profile: opts.profile,
        holders
      };
    }
    const lease = {
      id: randomUUID(),
      provider: opts.provider,
      profile: opts.profile,
      holder: opts.holder,
      acquiredAt: new Date().toISOString()
    };
    this.leases.set(lease.id, lease);
    return { ok: true, lease, queued: false };
  }
  release(id) {
    return this.leases.delete(id);
  }
  releaseHolder(holder) {
    let n = 0;
    for (const [id, lease] of this.leases) {
      if (lease.holder === holder) {
        this.leases.delete(id);
        n += 1;
      }
    }
    return n;
  }
}

// src/refresh-lock.ts
class AccountRefreshLock {
  inflight = new Map;
  async withLock(accountKey, fn) {
    const existing = this.inflight.get(accountKey);
    if (existing) {
      return existing;
    }
    const run = (async () => {
      try {
        return await fn();
      } finally {
        this.inflight.delete(accountKey);
      }
    })();
    this.inflight.set(accountKey, run);
    return run;
  }
}

// src/router.ts
var ELIGIBLE = ["AVAILABLE", "ACTIVE"];
function isEligible(a, now = Date.now()) {
  if (a.disabled)
    return false;
  if (a.auth === "revoked")
    return false;
  if (a.availability === "AUTH_REVOKED" || a.availability === "REQUIRES_LOGIN" || a.availability === "DISABLED") {
    return false;
  }
  if ((a.availability === "COOLDOWN" || a.availability === "RATE_LIMITED" || a.availability === "QUOTA_EXHAUSTED") && a.until) {
    if (Date.parse(a.until) > now)
      return false;
  } else if (a.availability === "COOLDOWN" || a.availability === "RATE_LIMITED" || a.availability === "QUOTA_EXHAUSTED" || a.availability === "AUTH_EXPIRED") {
    return false;
  }
  return ELIGIBLE.includes(a.availability) || a.availability === "UNKNOWN";
}

class OarRouter {
  store;
  constructor(store) {
    this.store = store;
  }
  resolve(req) {
    const policy = this.store.getProviderPolicy(req.provider);
    const accounts = this.store.listAccounts(req.provider);
    if (accounts.length === 0) {
      return {
        provider: req.provider,
        profile: "",
        status: "unavailable",
        availability: "UNKNOWN",
        reason: "no_accounts"
      };
    }
    if (policy.mode === "manual" && policy.preferred) {
      const preferred = accounts.find((a) => a.profile === policy.preferred);
      if (preferred && isEligible(preferred)) {
        return this.toResponse(preferred);
      }
      if (preferred && !policy.autoFailover) {
        return {
          provider: req.provider,
          profile: preferred.profile,
          status: "unavailable",
          availability: preferred.availability,
          reason: preferred.reason ?? preferred.availability
        };
      }
    }
    const eligible = accounts.filter((a) => isEligible(a)).sort((a, b) => {
      if (policy.preferred) {
        if (a.profile === policy.preferred)
          return -1;
        if (b.profile === policy.preferred)
          return 1;
      }
      if (a.priority !== b.priority)
        return a.priority - b.priority;
      const au = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
      const bu = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
      return au - bu;
    });
    const pick = eligible[0];
    if (!pick) {
      const anyRevoked = accounts.every((a) => a.availability === "AUTH_REVOKED" || a.availability === "REQUIRES_LOGIN");
      return {
        provider: req.provider,
        profile: policy.preferred ?? accounts[0]?.profile ?? "",
        status: "unavailable",
        availability: anyRevoked ? "REQUIRES_LOGIN" : "UNKNOWN",
        reason: "no_eligible_accounts"
      };
    }
    return this.toResponse(pick);
  }
  use(provider, profile) {
    const account = this.store.getAccount(provider, profile);
    if (!account) {
      throw new Error(`Unknown account ${provider}/${profile}`);
    }
    this.store.setPreferred(provider, profile);
    this.store.upsertAccount({
      ...account,
      lastUsedAt: new Date().toISOString()
    });
    return this.resolve({ provider });
  }
  setMode(provider, mode) {
    this.store.setProviderMode(provider, mode);
  }
  reportResult(req) {
    const account = this.store.getAccount(req.provider, req.account);
    if (!account)
      return;
    if (req.result === "SUCCESS") {
      const next2 = {
        ...account,
        auth: "valid",
        availability: "AVAILABLE",
        reason: undefined,
        until: null,
        lastChecked: new Date().toISOString(),
        lastUsedAt: new Date().toISOString()
      };
      this.store.upsertAccount(next2);
      return next2;
    }
    const failure = req.result;
    const next = { ...account, lastChecked: new Date().toISOString(), reason: req.detail ?? failure };
    switch (failure) {
      case "AUTH_REVOKED":
        next.auth = "revoked";
        next.availability = "AUTH_REVOKED";
        break;
      case "AUTH_EXPIRED":
        next.auth = "expired";
        next.availability = "AUTH_EXPIRED";
        break;
      case "RATE_LIMITED":
        next.availability = "RATE_LIMITED";
        next.until = req.retryAfterSec ? new Date(Date.now() + req.retryAfterSec * 1000).toISOString() : null;
        break;
      case "QUOTA_EXHAUSTED":
        next.availability = "QUOTA_EXHAUSTED";
        next.until = req.retryAfterSec ? new Date(Date.now() + req.retryAfterSec * 1000).toISOString() : null;
        break;
      default:
        this.store.upsertAccount(next);
        return next;
    }
    this.store.upsertAccount(next);
    const policy = this.store.getProviderPolicy(req.provider);
    if (policy.autoFailover && isAccountFailoverCandidate(failure) && policy.mode === "auto") {}
    return next;
  }
  toResponse(account) {
    return {
      provider: account.provider,
      profile: account.profile,
      status: "available",
      availability: account.availability,
      credentialRef: account.credentialRef
    };
  }
}

// src/daemon.ts
function readFrame(buf) {
  const idx = buf.indexOf(0);
  if (idx === -1)
    return { rest: buf };
  return { msg: buf.subarray(0, idx).toString("utf8"), rest: buf.subarray(idx + 1) };
}

class OarDaemon {
  store;
  router;
  activator;
  socketPath;
  activateOnUse;
  refreshLock = new AccountRefreshLock;
  leases = new LeaseManager;
  events;
  server = null;
  constructor(opts) {
    this.store = opts.store;
    this.router = new OarRouter(opts.store);
    this.activator = new AuthSlotActivator({
      store: opts.store,
      authPaths: opts.authPaths,
      preferSenpiLock: opts.preferSenpiLock
    });
    this.socketPath = opts.socketPath;
    this.activateOnUse = opts.activateOnUse ?? true;
    this.events = EventLog.forRoot(opts.store.rootDir);
  }
  get refresh() {
    return this.refreshLock;
  }
  get leaseManager() {
    return this.leases;
  }
  async start() {
    mkdirSync3(dirname4(this.socketPath), { recursive: true, mode: 448 });
    if (existsSync5(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        try {
          chmodSync3(this.socketPath, 384);
        } catch {}
        resolve();
      });
    });
    writeFileSync2(`${this.socketPath}.pid`, String(process.pid), { mode: 384 });
    this.events.append({ ts: new Date().toISOString(), event: "daemon_start", pid: process.pid });
  }
  async stop() {
    await new Promise((resolve) => {
      if (!this.server)
        return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    if (existsSync5(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    const pidPath = `${this.socketPath}.pid`;
    if (existsSync5(pidPath)) {
      try {
        unlinkSync(pidPath);
      } catch {}
    }
    this.events.append({ ts: new Date().toISOString(), event: "daemon_stop", pid: process.pid });
  }
  handleSocket(socket) {
    let buf = Buffer.alloc(0);
    socket.on("data", async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const { msg, rest } = readFrame(buf);
        buf = rest;
        if (msg === undefined)
          break;
        let response;
        try {
          const req = JSON.parse(msg);
          response = await this.dispatch(req);
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        socket.write(Buffer.concat([Buffer.from(JSON.stringify(response), "utf8"), Buffer.from([0])]));
      }
    });
  }
  async dispatch(req) {
    if (!req || req.protocol !== 1) {
      return { ok: false, error: "unsupported protocol" };
    }
    switch (req.action) {
      case "ping":
        return { ok: true, data: { pong: true, pid: process.pid } };
      case "resolve":
        return { ok: true, data: this.router.resolve(req) };
      case "use": {
        const resolved = this.router.use(req.provider, req.profile);
        this.events.append({
          ts: new Date().toISOString(),
          event: "use",
          provider: req.provider,
          profile: req.profile,
          reason: "manual",
          pid: process.pid
        });
        if (this.activateOnUse) {
          const act = await this.activator.activate(req.provider, req.profile);
          return {
            ok: true,
            data: {
              ...resolved,
              activatedPaths: act.paths,
              via: act.via,
              message: `${req.provider} ${req.profile} is now preferred. Running OMO sessions will use it on their next eligible request.`
            }
          };
        }
        return { ok: true, data: resolved };
      }
      case "auto":
        this.store.setProviderMode(req.provider, req.enabled ? "auto" : "manual");
        this.store.setAutoFailover(req.provider, req.enabled);
        this.events.append({
          ts: new Date().toISOString(),
          event: "auto",
          provider: req.provider,
          reason: req.enabled ? "on" : "off"
        });
        return {
          ok: true,
          data: { provider: req.provider, mode: req.enabled ? "auto" : "manual", autoFailover: req.enabled }
        };
      case "mode":
        this.router.setMode(req.provider, req.mode);
        return { ok: true, data: { provider: req.provider, mode: req.mode } };
      case "report": {
        const updated = this.router.reportResult({
          provider: req.provider,
          account: req.account,
          result: req.result,
          retryAfterSec: req.retryAfterSec,
          detail: req.detail
        });
        this.events.append({
          ts: new Date().toISOString(),
          event: "report",
          provider: req.provider,
          profile: req.account,
          reason: String(req.result)
        });
        const policy = this.store.getProviderPolicy(req.provider);
        if (this.activateOnUse && policy.autoFailover && policy.mode === "auto" && (req.result === "AUTH_REVOKED" || req.result === "RATE_LIMITED" || req.result === "QUOTA_EXHAUSTED")) {
          const next = this.router.resolve({ provider: req.provider });
          if (next.status === "available" && next.profile && next.profile !== req.account) {
            try {
              await this.activator.activate(req.provider, next.profile);
              this.events.append({
                ts: new Date().toISOString(),
                event: "failover",
                provider: req.provider,
                profile: next.profile,
                reason: `from ${req.account}`
              });
            } catch {}
          }
        }
        return { ok: true, data: updated };
      }
      case "status": {
        const state = this.store.getState();
        const providers = [...new Set(state.accounts.map((a) => a.provider))];
        return {
          ok: true,
          data: {
            state,
            authPaths: this.activator.getAuthPaths(),
            accounts: state.accounts,
            leases: this.leases.list(),
            resolvePreview: providers.map((p) => this.router.resolve({ provider: p }))
          }
        };
      }
      case "accounts":
        return { ok: true, data: this.store.listAccounts(req.provider) };
      case "add": {
        this.store.upsertAccount({
          provider: req.provider,
          profile: req.profile,
          auth: "unknown",
          availability: "UNKNOWN",
          priority: req.priority ?? 100,
          credentialRef: `vault:${req.provider}:${req.profile}`
        });
        return { ok: true, data: this.store.getAccount(req.provider, req.profile) };
      }
      case "remove": {
        this.store.removeAccount(req.provider, req.profile);
        this.events.append({
          ts: new Date().toISOString(),
          event: "remove",
          provider: req.provider,
          profile: req.profile
        });
        return { ok: true, data: { provider: req.provider, profile: req.profile } };
      }
      case "import-credential": {
        const credential = req.credential;
        if (!credential || credential.type !== "oauth" && credential.type !== "api_key") {
          return { ok: false, error: "credential must be oauth or api_key" };
        }
        if (!this.store.getAccount(req.provider, req.profile)) {
          this.store.upsertAccount({
            provider: req.provider,
            profile: req.profile,
            auth: "valid",
            availability: "AVAILABLE",
            priority: 100,
            credentialRef: `vault:${req.provider}:${req.profile}`
          });
        }
        this.store.putVaultCredential(req.provider, req.profile, credential);
        return { ok: true, data: { provider: req.provider, profile: req.profile } };
      }
      case "activate": {
        const act = await this.activator.activate(req.provider, req.profile);
        this.router.use(req.provider, req.profile);
        return { ok: true, data: act };
      }
      case "acquire-lease": {
        const resolved = req.profile ? { profile: req.profile, status: "available" } : this.router.resolve({ provider: req.provider });
        if (resolved.status !== "available" || !resolved.profile) {
          return { ok: false, error: `no eligible account for ${req.provider}` };
        }
        const account = this.store.getAccount(req.provider, resolved.profile);
        const result = this.leases.acquire({
          provider: req.provider,
          profile: resolved.profile,
          holder: req.holder,
          maxConcurrent: account?.maxConcurrent
        });
        if (!result.ok) {
          return { ok: false, error: `account ${req.provider}/${resolved.profile} at maxConcurrent (${result.holders})` };
        }
        return { ok: true, data: result.lease };
      }
      case "release-lease": {
        if (req.leaseId) {
          return { ok: true, data: { released: this.leases.release(req.leaseId) } };
        }
        if (req.holder) {
          return { ok: true, data: { released: this.leases.releaseHolder(req.holder) } };
        }
        return { ok: false, error: "leaseId or holder required" };
      }
      case "refresh": {
        const account = this.store.getAccount(req.provider, req.profile);
        if (!account)
          return { ok: false, error: `unknown account ${req.provider}/${req.profile}` };
        const adapter = createAdapter(req.provider, this.store);
        if (!adapter?.executeRefresh)
          return { ok: false, error: `no refresh adapter for ${req.provider}` };
        const cred = this.store.getVaultCredential(req.provider, req.profile);
        if (!cred)
          return { ok: false, error: "missing vault credential" };
        try {
          const refreshed = await this.refreshLock.withLock(`${req.provider}:${req.profile}`, async () => {
            const latest = this.store.getVaultCredential(req.provider, req.profile) ?? cred;
            if (latest.type === "oauth" && Date.now() + 5 * 60 * 1000 < latest.expires) {
              return { credential: latest, skipped: true };
            }
            const result = await adapter.executeRefresh(account, latest);
            this.store.putVaultCredential(req.provider, req.profile, result.credential);
            if (this.activateOnUse) {
              await this.activator.activate(req.provider, req.profile);
            }
            return { credential: result.credential, skipped: false };
          });
          this.events.append({
            ts: new Date().toISOString(),
            event: "refresh",
            provider: req.provider,
            profile: req.profile,
            reason: refreshed.skipped ? "already_fresh" : "rotated"
          });
          return { ok: true, data: { provider: req.provider, profile: req.profile, skipped: refreshed.skipped } };
        } catch (error) {
          const classified = classifyFailure({
            provider: req.provider,
            status: error.status,
            body: error instanceof Error ? error.message : String(error)
          });
          this.router.reportResult({
            provider: req.provider,
            account: req.profile,
            result: classified,
            detail: error instanceof Error ? error.message : String(error)
          });
          this.events.append({
            ts: new Date().toISOString(),
            event: "refresh_failed",
            provider: req.provider,
            profile: req.profile,
            reason: classified
          });
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "test": {
        const account = this.store.getAccount(req.provider, req.profile);
        if (!account)
          return { ok: false, error: `unknown account ${req.provider}/${req.profile}` };
        const adapter = createAdapter(req.provider, this.store);
        if (!adapter) {
          return {
            ok: true,
            data: { provider: req.provider, profile: req.profile, health: "UNKNOWN", note: "no adapter" }
          };
        }
        const health = await adapter.healthCheck(account);
        if (!req.live) {
          return { ok: true, data: { provider: req.provider, profile: req.profile, ...health } };
        }
        let live;
        if (!adapter.liveCheck) {
          live = { reachable: null, detail: "no live check implemented for this provider" };
        } else {
          const cred = this.store.getVaultCredential(req.provider, req.profile);
          if (!cred) {
            live = { reachable: false, detail: "missing_vault_credential" };
          } else {
            try {
              live = await adapter.liveCheck(account, cred);
            } catch (error) {
              live = { reachable: false, detail: error instanceof Error ? error.message : String(error) };
            }
          }
        }
        return { ok: true, data: { provider: req.provider, profile: req.profile, ...health, live } };
      }
      case "doctor":
        return {
          ok: true,
          data: {
            socketPath: this.socketPath,
            rootDir: this.store.rootDir,
            authPaths: this.activator.getAuthPaths(),
            accountCount: this.store.listAccounts().length,
            leaseCount: this.leases.list().length,
            pid: process.pid
          }
        };
      default:
        return { ok: false, error: `unknown action` };
    }
  }
}

// src/paths.ts
import { existsSync as existsSync6 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
function defaultOarRoot2(env = process.env) {
  if (env.OAR_HOME)
    return env.OAR_HOME;
  return join3(homedir3(), ".oar");
}
function oarSocketPath(root = defaultOarRoot2()) {
  return join3(root, "oar.sock");
}
function unique2(paths) {
  const out = [];
  for (const p of paths) {
    if (!out.includes(p))
      out.push(p);
  }
  return out;
}
function resolveActiveAuthPaths2(env = process.env, home = homedir3()) {
  const envDirs = [
    env.OAR_AUTH_DIR,
    env.OMO_CODING_AGENT_DIR,
    env.SENPI_CODING_AGENT_DIR,
    env.PI_CODING_AGENT_DIR
  ].filter((v) => typeof v === "string" && v.length > 0);
  if (env.OAR_AUTH_PATH)
    return unique2([env.OAR_AUTH_PATH]);
  if (envDirs.length > 0)
    return unique2(envDirs.map((dir) => join3(dir, "auth.json")));
  const known = knownAuthJsonCandidates2(home);
  if (env.OAR_ACTIVATE_ALL === "1") {
    const existing = known.filter((p) => existsSync6(p));
    return existing.length > 0 ? existing : [known[0]];
  }
  const omoAgent = join3(home, ".omo", "agent", "auth.json");
  if (existsSync6(omoAgent) || existsSync6(join3(home, ".omo")))
    return [omoAgent];
  return [join3(home, ".senpi", "agent", "auth.json")];
}
function knownAuthJsonCandidates2(home) {
  return unique2([
    join3(home, ".omo", "agent", "auth.json"),
    join3(home, ".omo", "auth.json"),
    join3(home, ".senpi", "agent", "auth.json")
  ]);
}

// src/store.ts
import {
  chmodSync as chmodSync4,
  existsSync as existsSync7,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { dirname as dirname5, join as join4 } from "node:path";
var DEFAULT_POLICY = {
  mode: "manual",
  autoFailover: false
};
function emptyState() {
  return { version: 1, providers: {}, accounts: [], updatedAt: new Date().toISOString() };
}
function atomicWriteJson(path, data, mode = 384) {
  mkdirSync4(dirname5(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync3(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync2(tmp, path);
  try {
    chmodSync4(path, mode);
  } catch {}
}

class OarStore {
  rootDir;
  statePath;
  vaultDir;
  state;
  constructor(opts) {
    this.rootDir = opts?.rootDir ?? defaultOarRoot();
    this.statePath = oarStatePath(this.rootDir);
    this.vaultDir = oarVaultDir(this.rootDir);
    mkdirSync4(this.rootDir, { recursive: true, mode: 448 });
    mkdirSync4(this.vaultDir, { recursive: true, mode: 448 });
    this.state = this.load();
  }
  load() {
    if (!existsSync7(this.statePath))
      return emptyState();
    try {
      const parsed = JSON.parse(readFileSync3(this.statePath, "utf8"));
      if (parsed?.version !== 1)
        return emptyState();
      return {
        version: 1,
        providers: parsed.providers ?? {},
        accounts: parsed.accounts ?? [],
        updatedAt: parsed.updatedAt ?? new Date().toISOString()
      };
    } catch {
      return emptyState();
    }
  }
  persist() {
    this.state.updatedAt = new Date().toISOString();
    atomicWriteJson(this.statePath, this.state, 384);
  }
  getState() {
    return structuredClone(this.state);
  }
  listAccounts(provider) {
    return this.state.accounts.filter((a) => provider ? a.provider === provider : true);
  }
  getAccount(provider, profile) {
    return this.state.accounts.find((a) => a.provider === provider && a.profile === profile);
  }
  upsertAccount(account) {
    const idx = this.state.accounts.findIndex((a) => a.provider === account.provider && a.profile === account.profile);
    if (idx >= 0)
      this.state.accounts[idx] = account;
    else
      this.state.accounts.push(account);
    this.persist();
  }
  removeAccount(provider, profile) {
    this.state.accounts = this.state.accounts.filter((a) => !(a.provider === provider && a.profile === profile));
    this.persist();
    const vaultPath = this.vaultPath(provider, profile);
    if (existsSync7(vaultPath)) {
      try {
        unlinkSync2(vaultPath);
      } catch {}
    }
  }
  getProviderPolicy(provider) {
    return { ...DEFAULT_POLICY, ...this.state.providers[provider] ?? {} };
  }
  setProviderMode(provider, mode) {
    const cur = this.getProviderPolicy(provider);
    this.state.providers[provider] = { ...cur, mode };
    this.persist();
  }
  setAutoFailover(provider, enabled) {
    const cur = this.getProviderPolicy(provider);
    this.state.providers[provider] = { ...cur, autoFailover: enabled };
    this.persist();
  }
  setPreferred(provider, profile) {
    const cur = this.getProviderPolicy(provider);
    this.state.providers[provider] = { ...cur, preferred: profile };
    this.persist();
  }
  vaultPath(provider, profile) {
    return join4(this.vaultDir, `${provider}__${profile}.json`);
  }
  putVaultCredential(provider, profile, credential) {
    atomicWriteJson(this.vaultPath(provider, profile), credential, 384);
    const ref = `vault:${provider}:${profile}`;
    const existing = this.getAccount(provider, profile);
    if (existing) {
      this.upsertAccount({ ...existing, credentialRef: ref, auth: "valid", lastChecked: new Date().toISOString() });
    }
  }
  getVaultCredential(provider, profile) {
    const path = this.vaultPath(provider, profile);
    if (!existsSync7(path))
      return;
    try {
      return JSON.parse(readFileSync3(path, "utf8"));
    } catch {
      return;
    }
  }
}

// src/daemon-main.ts
var root = process.env.OAR_HOME ?? defaultOarRoot2();
var socketPath = process.env.OAR_SOCK ?? oarSocketPath(root);
var store = new OarStore({ rootDir: root });
var daemon = new OarDaemon({
  store,
  socketPath,
  authPaths: resolveActiveAuthPaths2(),
  activateOnUse: true
});
async function main() {
  await daemon.start();
  console.log(`oar-daemon listening on ${socketPath}`);
  console.log(`auth paths: ${resolveActiveAuthPaths2().join(", ")}`);
  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
