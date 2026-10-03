#!/usr/bin/env node
// @bun

// src/daemon.ts
import { chmodSync as chmodSync5, existsSync as existsSync13, mkdirSync as mkdirSync7, unlinkSync, writeFileSync as writeFileSync6 } from "node:fs";
import { createServer } from "node:net";
import { dirname as dirname8 } from "node:path";

// src/provider-alias.ts
var PROVIDER_ALIASES = {
  "chatgpt-subscription": "chatgpt-subscription",
  "openai-codex": "chatgpt-subscription",
  openai: "chatgpt-subscription",
  codex: "chatgpt-subscription",
  chatgpt: "chatgpt-subscription",
  xai: "xai",
  grok: "xai"
};
function resolveProvider(input) {
  const key = input.trim().toLowerCase();
  return PROVIDER_ALIASES[key] ?? input.trim();
}

// src/classifier.ts
function norm(s) {
  return (s ?? "").toLowerCase();
}
function headerHaystack(headers) {
  if (!headers)
    return "";
  const parts = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value == null)
      continue;
    parts.push(key, Array.isArray(value) ? value.join(" ") : String(value));
  }
  return parts.join(" ").toLowerCase();
}
function classifyFailure(input) {
  const body = norm(input.body);
  const headersText = headerHaystack(input.headers);
  const text = `${body} ${headersText}`.trim();
  const code = norm(input.code);
  const status = input.status;
  if (text.includes("invalid_grant") || text.includes("refresh token has been revoked") || text.includes("refresh_token_revoked") || code === "invalid_grant") {
    return "AUTH_REVOKED";
  }
  if (status === 401 || text.includes("unauthorized") || text.includes("token expired") || text.includes("auth_expired") || text.includes("invalid_token")) {
    if (text.includes("revok"))
      return "AUTH_REVOKED";
    return "AUTH_EXPIRED";
  }
  if (status === 429 || text.includes("rate limit") || text.includes("rate_limit")) {
    return "RATE_LIMITED";
  }
  if (status === 402 || status === 403 || text.includes("quota") || text.includes("insufficient_quota") || text.includes("usage limit") || text.includes("run out of credits") || text.includes("out of credits") || text.includes("need a grok subscription") || text.includes("add credits") || text.includes("supergrok")) {
    return "QUOTA_EXHAUSTED";
  }
  if (status === 404 || text.includes("model_not_found") || text.includes("model not found")) {
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
  if (text.includes("network") || text.includes("econnreset") || text.includes("fetch failed")) {
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
  provider = "chatgpt-subscription";
  constructor(store) {
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
    const idToken = typeof parsed.id_token === "string" && parsed.id_token.length > 0 ? parsed.id_token : credential.idToken;
    return {
      credential: {
        type: "oauth",
        access,
        refresh,
        expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS2,
        ...credential.accountId ? { accountId: credential.accountId } : {},
        ...idToken ? { idToken } : {}
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
  switch (resolveProvider(provider)) {
    case "xai":
      return new XaiAdapter(store);
    case "anthropic":
      return new AnthropicAdapter(store);
    case "chatgpt-subscription":
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

// src/credential-identity.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2)
    return;
  const payload = parts[1];
  if (!payload)
    return;
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - padded.length % 4);
    const json = Buffer.from(padded + pad, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}
var OPENAI_PROFILE = "https://api.openai.com/profile";
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function emailFromUnknown(value) {
  if (typeof value !== "string")
    return;
  const trimmed = value.trim();
  return looksLikeEmail(trimmed) ? trimmed : undefined;
}
function emailFromJwtPayload(payload) {
  if (!payload)
    return;
  const nested = payload[OPENAI_PROFILE];
  if (isRecord(nested)) {
    const fromProfile = emailFromUnknown(nested.email);
    if (fromProfile)
      return fromProfile;
  }
  return emailFromUnknown(payload.email) ?? emailFromUnknown(payload.preferred_username);
}
function loginFromCredential(cred) {
  if (!cred || cred.type !== "oauth")
    return;
  if (cred.idToken) {
    const fromId = emailFromJwtPayload(decodeJwtPayload(cred.idToken));
    if (fromId)
      return fromId;
  }
  return emailFromJwtPayload(decodeJwtPayload(cred.access));
}
function subjectFromCredential(cred) {
  if (!cred || cred.type !== "oauth")
    return;
  const subject = decodeJwtPayload(cred.access)?.sub;
  return typeof subject === "string" && subject.length > 0 ? subject : undefined;
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
function oarPromotionPath(root = defaultOarRoot()) {
  return join2(root, "promotion.json");
}
function oarQueuePath(root = defaultOarRoot()) {
  return join2(root, "queue.json");
}
function oarQueueDir(root = defaultOarRoot()) {
  return join2(root, "queue");
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
  if (env.OAR_AUTH_PATH)
    return unique([env.OAR_AUTH_PATH]);
  const envDirs = [
    env.OAR_AUTH_DIR,
    env.OMO_CODING_AGENT_DIR,
    env.SENPI_CODING_AGENT_DIR,
    env.PI_CODING_AGENT_DIR
  ].filter((v) => typeof v === "string" && v.length > 0);
  const known = knownAuthJsonCandidates(home);
  const existing = known.filter((p) => existsSync2(p));
  const selected = envDirs.length > 0 ? envDirs.map((dir) => join2(dir, "auth.json")) : [];
  const targets = unique([...selected, ...existing]);
  if (targets.length > 0)
    return targets;
  return [join2(home, ".omo", "agent", "auth.json")];
}
function knownAuthJsonCandidates(home) {
  return unique([
    join2(home, ".omo", "agent", "auth.json"),
    join2(home, ".omo", "auth.json"),
    join2(home, ".senpi", "agent", "auth.json"),
    join2(home, ".senpi", "remote-agent", "auth.json")
  ]);
}

// src/auth-slot.ts
class AuthSlotActivator {
  store;
  authPaths;
  preferSenpiLock;
  sinks;
  constructor(opts) {
    this.store = opts.store;
    this.authPaths = opts.authPaths ?? resolveActiveAuthPaths();
    this.preferSenpiLock = opts.preferSenpiLock ?? true;
    this.sinks = opts.sinks ?? [];
  }
  applySinks(provider, credential) {
    const results = [];
    for (const sink of this.sinks) {
      if (!sink.providers.includes(provider))
        continue;
      try {
        results.push(sink.apply(credential));
      } catch {
        results.push({ id: sink.id, status: "error", detail: "apply_failed" });
      }
    }
    return results;
  }
  getAuthPaths() {
    return [...this.authPaths];
  }
  clearMatchingSlots(provider, credential) {
    return this.authPaths.map((path) => ({
      path,
      result: clearMatchingProviderSlot(path, provider, credential)
    }));
  }
  async activate(provider, profile) {
    const cred = this.store.getVaultCredential(provider, profile);
    if (!cred) {
      throw new Error(`No vault credential for ${provider}/${profile}`);
    }
    const written = [];
    let via = "atomic-rename";
    for (const path of this.authPaths) {
      const usedSenpi = await this.writeAliasSlots(path, provider, cred);
      if (!usedSenpi)
        this.writeSlot(path, provider, cred);
      else
        via = "senpi-auth-storage";
      written.push(path);
    }
    this.markProfileActive(provider, profile);
    const sinks = this.applySinks(provider, cred);
    return { paths: written, via, sinks };
  }
  async ensureActivated(provider, profile) {
    const cred = this.store.getVaultCredential(provider, profile);
    if (!cred)
      throw new Error(`No vault credential for ${provider}/${profile}`);
    let sawMissing = false;
    let sawOtherKnownProfile = false;
    let fresherLive;
    for (const path of this.authPaths) {
      if (!existsSync3(path)) {
        sawMissing = true;
        continue;
      }
      let live;
      try {
        const data = JSON.parse(readFileSync2(path, "utf8"));
        live = data[provider];
      } catch {
        sawMissing = true;
        continue;
      }
      if (!live) {
        sawMissing = true;
        continue;
      }
      if (credentialsSameIdentity(live, cred)) {
        continue;
      }
      if (this.matchesOtherVaultProfile(provider, profile, live)) {
        sawOtherKnownProfile = true;
        continue;
      }
      if (isFresherOAuth(live, cred)) {
        if (!fresherLive || isFresherOAuth(live, fresherLive)) {
          fresherLive = live;
        }
        continue;
      }
      sawMissing = true;
    }
    if (fresherLive && !sawOtherKnownProfile) {
      this.store.putVaultCredential(provider, profile, fresherLive);
      this.markProfileActive(provider, profile);
      const act = await this.activate(provider, profile);
      return { ...act, via: `${act.via}+vault-pull-up`, skipped: false };
    }
    if (!sawMissing && !sawOtherKnownProfile && !fresherLive) {
      const sinks = this.applySinks(provider, cred);
      return { paths: [...this.authPaths], via: "already-matched", skipped: true, sinks };
    }
    const act = await this.activate(provider, profile);
    return {
      ...act,
      via: sawOtherKnownProfile ? `${act.via}+profile-realign` : act.via,
      skipped: false
    };
  }
  matchesOtherVaultProfile(provider, profile, live) {
    for (const other of this.store.listAccounts(provider)) {
      if (other.profile === profile)
        continue;
      const otherCred = this.store.getVaultCredential(provider, other.profile);
      if (otherCred && credentialsSameIdentity(live, otherCred))
        return true;
    }
    return false;
  }
  markProfileActive(provider, profile) {
    const account = this.store.getAccount(provider, profile);
    for (const other of this.store.listAccounts(provider)) {
      if (other.profile === profile)
        continue;
      if (other.availability === "ACTIVE") {
        this.store.upsertAccount({
          ...other,
          availability: "AVAILABLE"
        });
      }
    }
    if (account) {
      this.store.upsertAccount({
        ...account,
        lastUsedAt: new Date().toISOString(),
        availability: account.availability === "QUOTA_UNKNOWN" ? "QUOTA_UNKNOWN" : "ACTIVE"
      });
    }
  }
  async writeAliasSlots(authPath, provider, credential) {
    if (!this.preferSenpiLock)
      return false;
    const writeKeys = authJsonKeysForProvider(provider);
    for (const key of writeKeys) {
      const used = await this.writeSlotViaSenpi(authPath, key, credential);
      if (!used)
        return false;
    }
    return true;
  }
  async writeSlotViaSenpi(authPath, provider, credential) {
    try {
      const storage = await createSenpiAuthStorage(authPath);
      if (!storage)
        return false;
      await storage.modify(provider, async (current) => {
        return mergeProviderSlot(current, credential);
      });
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
    const writeKeys = authJsonKeysForProvider(provider);
    for (const key of writeKeys) {
      data[key] = mergeProviderSlot(data[key], credential);
    }
    const tmp = `${authPath}.oar.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 384 });
    renameSync(tmp, authPath);
    try {
      chmodSync(authPath, 384);
    } catch {}
  }
}
function mergeProviderSlot(existing, credential) {
  const next = { ...credential };
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return next;
  }
  const prev = existing;
  const sameSecrets = (prev.type === "oauth" || prev.type === "api_key") && credentialsSameSecrets(prev, credential);
  const previousSubject = prev.type === "oauth" ? subjectFromCredential(prev) : undefined;
  const nextSubject = subjectFromCredential(credential);
  const same = sameSecrets || Boolean(previousSubject && previousSubject === nextSubject);
  for (const [key, value] of Object.entries(prev)) {
    if (key in next)
      continue;
    if (!same && key === "accounts")
      continue;
    next[key] = value;
  }
  if (credential.type === "oauth" && !credential.accountId && same && typeof prev.accountId === "string") {
    next.accountId = prev.accountId;
  }
  return next;
}
function credentialsSameIdentity(a, b) {
  if (a.type !== b.type)
    return false;
  if (a.type === "api_key" && b.type === "api_key") {
    return a.key === b.key;
  }
  if (a.type === "oauth" && b.type === "oauth") {
    return a.access === b.access && a.refresh === b.refresh && (a.accountId ?? undefined) === (b.accountId ?? undefined);
  }
  return false;
}
function credentialsSameSecrets(a, b) {
  if (a.type !== b.type)
    return false;
  if (a.type === "api_key" && b.type === "api_key")
    return a.key === b.key;
  if (a.type === "oauth" && b.type === "oauth") {
    return a.access === b.access && a.refresh === b.refresh;
  }
  return false;
}
function authJsonKeysForProvider(provider) {
  const canonical = resolveProvider(provider);
  if (canonical === "chatgpt-subscription")
    return ["chatgpt-subscription", "openai-codex"];
  return [canonical];
}
function sameAccountLineage(live, vault) {
  if (credentialsSameSecrets(live, vault))
    return true;
  if (live.type !== "oauth" || vault.type !== "oauth")
    return false;
  if (live.refresh && live.refresh === vault.refresh)
    return true;
  return Boolean(live.accountId && vault.accountId && live.accountId === vault.accountId);
}
function clearMatchingProviderSlot(authPath, provider, credential) {
  if (!existsSync3(authPath))
    return "absent";
  let data;
  try {
    const parsed = JSON.parse(readFileSync2(authPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return "kept";
    data = parsed;
  } catch {
    throw new Error(`unable to read auth slot ${authPath}`);
  }
  let cleared = false;
  let sawSlot = false;
  for (const key of authJsonKeysForProvider(provider)) {
    const slot = data[key];
    if (!slot || typeof slot !== "object" || Array.isArray(slot))
      continue;
    sawSlot = true;
    if (!sameAccountLineage(slot, credential))
      continue;
    delete data[key];
    cleared = true;
  }
  if (!cleared)
    return sawSlot ? "kept" : "absent";
  const tmp = `${authPath}.oar.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 384 });
  renameSync(tmp, authPath);
  try {
    chmodSync(authPath, 384);
  } catch {}
  return "cleared";
}
function isFresherOAuth(candidate, baseline) {
  if (candidate.type !== "oauth" || baseline.type !== "oauth")
    return false;
  if (candidate.accountId && baseline.accountId && candidate.accountId !== baseline.accountId) {
    return false;
  }
  if (credentialsSameIdentity(candidate, baseline) && candidate.expires === baseline.expires) {
    return false;
  }
  return candidate.expires > baseline.expires;
}

// src/sinks/index.ts
import { homedir as homedir3 } from "node:os";

// src/sinks/argo-grok.ts
import { existsSync as existsSync5, readdirSync, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";

// src/sinks/write-json.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync2, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname3 } from "node:path";
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseJsonText(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
function atomicWriteJson(path, data) {
  mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
  const tmp = `${path}.tmp`;
  writeFileSync2(tmp, `${JSON.stringify(data, null, 2)}
`, { encoding: "utf8", mode: 384 });
  renameSync2(tmp, path);
}

// src/sinks/argo-grok.ts
var ARGO_GROK_SINK_ID = "argo-grok";
function mapXaiToArgoGrok(credential) {
  return {
    type: "oauth",
    value: JSON.stringify({
      access_token: credential.access,
      refresh_token: credential.refresh,
      expires_at: credential.expires
    })
  };
}
function discoverArgoSecretFiles(env) {
  const override = env.env.OAR_ARGO_SECRETS_PATH;
  if (typeof override === "string" && override.length > 0) {
    return existsSync5(override) ? [override] : [];
  }
  const root = join3(env.home, "Library", "Application Support", "com.beyondworks.argo", "workspaces");
  if (!existsSync5(root))
    return [];
  const out = [];
  const accountLocal = join3(root, ".account-secrets-local.json");
  if (existsSync5(accountLocal))
    out.push(accountLocal);
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch (error) {
    if (error instanceof Error)
      return out;
    throw error;
  }
  for (const name of entries) {
    if (name.startsWith("."))
      continue;
    const secrets = join3(root, name, ".secrets.json");
    if (existsSync5(secrets))
      out.push(secrets);
  }
  return out;
}
function patchArgoSecrets(raw, grok) {
  if (!isRecord2(raw))
    return null;
  const runners = raw.runners;
  if (!isRecord2(runners))
    return null;
  if (!("grok" in runners))
    return null;
  return {
    ...raw,
    runners: {
      ...runners,
      grok
    }
  };
}
function applyArgoGrokSecretFile(path, credential) {
  let raw;
  try {
    raw = readFileSync3(path, "utf8");
  } catch {
    return { id: ARGO_GROK_SINK_ID, status: "error", path, detail: "read_failed" };
  }
  const parsed = parseJsonText(raw);
  if (!parsed.ok) {
    return { id: ARGO_GROK_SINK_ID, status: "error", path, detail: "invalid_json" };
  }
  const next = patchArgoSecrets(parsed.value, mapXaiToArgoGrok(credential));
  if (!next) {
    return { id: ARGO_GROK_SINK_ID, status: "skipped", path, detail: "no_runners.grok" };
  }
  try {
    atomicWriteJson(path, next);
  } catch {
    return { id: ARGO_GROK_SINK_ID, status: "error", path, detail: "write_failed" };
  }
  return { id: ARGO_GROK_SINK_ID, status: "wrote", path };
}
function createArgoGrokSink(env) {
  return {
    id: ARGO_GROK_SINK_ID,
    providers: ["xai"],
    apply(credential) {
      if (credential.type !== "oauth") {
        return { id: ARGO_GROK_SINK_ID, status: "skipped", detail: "not_oauth" };
      }
      const files = discoverArgoSecretFiles(env);
      if (files.length === 0) {
        return { id: ARGO_GROK_SINK_ID, status: "skipped", detail: "no_argo_secrets" };
      }
      const wrote = [];
      const errors = [];
      for (const path of files) {
        const result = applyArgoGrokSecretFile(path, credential);
        if (result.status === "wrote" && result.path)
          wrote.push(result.path);
        if (result.status === "error")
          errors.push(`${path}: ${result.detail ?? "error"}`);
      }
      if (errors.length > 0 && wrote.length === 0) {
        return { id: ARGO_GROK_SINK_ID, status: "error", detail: errors.join("; ") };
      }
      if (wrote.length === 0) {
        return { id: ARGO_GROK_SINK_ID, status: "skipped", detail: "no_runners.grok" };
      }
      return {
        id: ARGO_GROK_SINK_ID,
        status: "wrote",
        path: wrote.join(","),
        detail: errors.length ? errors.join("; ") : undefined
      };
    }
  };
}

// src/sinks/codex-home.ts
import { existsSync as existsSync6, readFileSync as readFileSync4 } from "node:fs";
import { join as join4 } from "node:path";
var CODEX_HOME_SINK_ID = "codex-home";
function resolveCodexAuthPath(env) {
  const override = env.env.OAR_CODEX_AUTH_PATH;
  if (typeof override === "string" && override.length > 0) {
    return existsSync6(override) ? override : undefined;
  }
  const homeDir = env.env.OAR_CODEX_HOME ?? env.env.CODEX_HOME ?? join4(env.home, ".codex");
  const authPath = join4(homeDir, "auth.json");
  return existsSync6(authPath) ? authPath : undefined;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isSameCodexIdentity(prevTokens, credential) {
  const prevAccount = nonEmptyString(prevTokens.account_id);
  const nextAccount = nonEmptyString(credential.accountId);
  if (prevAccount && nextAccount && prevAccount !== nextAccount)
    return false;
  if (prevTokens.access_token === credential.access && prevTokens.refresh_token === credential.refresh) {
    return true;
  }
  if (prevAccount && nextAccount && prevAccount === nextAccount)
    return true;
  if (credential.idToken && prevTokens.id_token === credential.idToken)
    return true;
  return false;
}
function resolveCodexIdToken(prevTokens, credential, sameIdentity) {
  const imported = nonEmptyString(credential.idToken);
  if (imported)
    return imported;
  if (sameIdentity)
    return nonEmptyString(prevTokens.id_token);
  return;
}
function resolveCodexAccountId(prevTokens, credential, sameIdentity) {
  const next = nonEmptyString(credential.accountId);
  if (next)
    return next;
  if (sameIdentity)
    return nonEmptyString(prevTokens.account_id);
  return;
}
function tokenFingerprint(tokens, authMode, apiKey) {
  return JSON.stringify({
    auth_mode: authMode ?? null,
    OPENAI_API_KEY: apiKey ?? null,
    id_token: tokens.id_token ?? null,
    access_token: tokens.access_token ?? null,
    refresh_token: tokens.refresh_token ?? null,
    account_id: tokens.account_id ?? null
  });
}
function mapCodexAuthFile(existing, credential) {
  const prev = isRecord2(existing) ? existing : {};
  const prevTokens = isRecord2(prev.tokens) ? prev.tokens : {};
  const sameIdentity = isSameCodexIdentity(prevTokens, credential);
  const idToken = resolveCodexIdToken(prevTokens, credential, sameIdentity);
  const accountId = resolveCodexAccountId(prevTokens, credential, sameIdentity);
  const tokens = {};
  if (sameIdentity) {
    for (const [key, value] of Object.entries(prevTokens)) {
      if (key === "access_token" || key === "refresh_token" || key === "id_token" || key === "account_id") {
        continue;
      }
      tokens[key] = value;
    }
  }
  tokens.access_token = credential.access;
  tokens.refresh_token = credential.refresh;
  if (idToken)
    tokens.id_token = idToken;
  if (accountId)
    tokens.account_id = accountId;
  const unchanged = tokenFingerprint(prevTokens, prev.auth_mode, prev.OPENAI_API_KEY ?? null) === tokenFingerprint(tokens, "chatgpt", null);
  return {
    ...prev,
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens,
    last_refresh: unchanged && typeof prev.last_refresh === "string" ? prev.last_refresh : new Date().toISOString()
  };
}
function applyCodexAuthFile(path, credential) {
  let raw;
  try {
    raw = readFileSync4(path, "utf8");
  } catch {
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail: "read_failed" };
  }
  const parsed = parseJsonText(raw);
  if (!parsed.ok) {
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail: "invalid_json" };
  }
  const prev = isRecord2(parsed.value) ? parsed.value : {};
  const prevTokens = isRecord2(prev.tokens) ? prev.tokens : {};
  const sameIdentity = isSameCodexIdentity(prevTokens, credential);
  if (!resolveCodexIdToken(prevTokens, credential, sameIdentity)) {
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail: "missing_id_token" };
  }
  const next = mapCodexAuthFile(parsed.value, credential);
  const nextTokens = isRecord2(next.tokens) ? next.tokens : {};
  const unchanged = tokenFingerprint(prevTokens, prev.auth_mode, prev.OPENAI_API_KEY ?? null) === tokenFingerprint(nextTokens, next.auth_mode, next.OPENAI_API_KEY ?? null);
  if (unchanged) {
    return { id: CODEX_HOME_SINK_ID, status: "skipped", path, detail: "unchanged" };
  }
  try {
    atomicWriteJson(path, next);
  } catch {
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail: "write_failed" };
  }
  return { id: CODEX_HOME_SINK_ID, status: "wrote", path };
}
function createCodexHomeSink(env) {
  return {
    id: CODEX_HOME_SINK_ID,
    providers: ["chatgpt-subscription", "openai-codex"],
    apply(credential) {
      if (credential.type !== "oauth") {
        return { id: CODEX_HOME_SINK_ID, status: "skipped", detail: "not_oauth" };
      }
      const path = resolveCodexAuthPath(env);
      if (!path) {
        return { id: CODEX_HOME_SINK_ID, status: "skipped", detail: "no_codex_auth" };
      }
      return applyCodexAuthFile(path, credential);
    }
  };
}

// src/sinks/index.ts
function flagOff(value) {
  return value === "0" || value === "false" || value === "off";
}
function createDefaultSinks(opts) {
  const env = {
    home: opts?.home ?? homedir3(),
    env: opts?.env ?? process.env
  };
  if (flagOff(env.env.OAR_SINKS))
    return [];
  const sinks = [];
  if (!flagOff(env.env.OAR_ARGO_SINK)) {
    sinks.push(createArgoGrokSink(env));
  }
  if (!flagOff(env.env.OAR_CODEX_SINK)) {
    sinks.push(createCodexHomeSink(env));
  }
  return sinks;
}

// src/events.ts
import { appendFileSync, chmodSync as chmodSync2, existsSync as existsSync7, mkdirSync as mkdirSync3 } from "node:fs";
import { dirname as dirname4 } from "node:path";
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
    mkdirSync3(dirname4(this.path), { recursive: true, mode: 448 });
    const line = JSON.stringify(scrub({ ...event, ts: event.ts || new Date().toISOString() })) + `
`;
    const existed = existsSync7(this.path);
    appendFileSync(this.path, line, { encoding: "utf8", mode: 384 });
    if (!existed) {
      try {
        chmodSync2(this.path, 384);
      } catch {}
    }
  }
}

// src/lease.ts
var DEFAULT_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

class LeaseManager {
  leases = new Map;
  ttlMs;
  constructor(opts) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  }
  isExpired(lease, now = Date.now()) {
    const acquired = Date.parse(lease.acquiredAt);
    if (!Number.isFinite(acquired))
      return true;
    return now - acquired > this.ttlMs;
  }
  sweep(now = Date.now()) {
    let n = 0;
    for (const [id, lease] of this.leases) {
      if (this.isExpired(lease, now)) {
        this.leases.delete(id);
        n += 1;
      }
    }
    return n;
  }
  acquire(opts) {
    this.sweep();
    const active = [...this.leases.values()].filter((l) => l.provider === opts.provider && l.profile === opts.profile);
    if (opts.maxConcurrent != null && active.length >= opts.maxConcurrent) {
      return { ok: false, reason: "max_concurrent", holders: active.length };
    }
    const lease = {
      id: crypto.randomUUID(),
      provider: opts.provider,
      profile: opts.profile,
      holder: opts.holder,
      acquiredAt: new Date().toISOString()
    };
    this.leases.set(lease.id, lease);
    return { ok: true, lease };
  }
  release(leaseId) {
    this.sweep();
    return this.leases.delete(leaseId);
  }
  releaseHolder(holder) {
    this.sweep();
    let n = 0;
    for (const [id, lease] of this.leases) {
      if (lease.holder === holder) {
        this.leases.delete(id);
        n += 1;
      }
    }
    return n;
  }
  releaseAccount(provider, profile) {
    this.sweep();
    let n = 0;
    for (const [id, lease] of this.leases) {
      if (lease.provider === provider && lease.profile === profile) {
        this.leases.delete(id);
        n += 1;
      }
    }
    return n;
  }
  list() {
    this.sweep();
    return [...this.leases.values()];
  }
  count(provider, profile) {
    this.sweep();
    return [...this.leases.values()].filter((l) => l.provider === provider && l.profile === profile).length;
  }
}

// src/promotion.ts
var DEFAULT_PROMOTION_SCHEDULE = {
  enabled: false,
  timezone: "Asia/Seoul",
  start: "00:00",
  end: "10:00",
  provider: "opengateway",
  model: "deepseek/deepseek-v4.1-flash-ultrafast",
  maxConcurrency: 3,
  maxAttempts: 3
};
function promotionalModelSelector(schedule) {
  return `${schedule.provider}/${schedule.model}`;
}
function parseClock(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match)
    throw new Error(`invalid time ${hhmm}; use HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59)
    throw new Error(`invalid time ${hhmm}; use HH:MM`);
  return hour * 60 + minute;
}
function assertValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`invalid timezone ${timeZone}`);
  }
}
function normalizePromotionSchedule(raw) {
  const next = {
    enabled: Boolean(raw?.enabled),
    timezone: typeof raw?.timezone === "string" && raw.timezone ? raw.timezone : DEFAULT_PROMOTION_SCHEDULE.timezone,
    start: typeof raw?.start === "string" && raw.start ? raw.start : DEFAULT_PROMOTION_SCHEDULE.start,
    end: typeof raw?.end === "string" && raw.end ? raw.end : DEFAULT_PROMOTION_SCHEDULE.end,
    provider: typeof raw?.provider === "string" && raw.provider ? raw.provider : DEFAULT_PROMOTION_SCHEDULE.provider,
    model: typeof raw?.model === "string" && raw.model ? raw.model : DEFAULT_PROMOTION_SCHEDULE.model,
    maxConcurrency: Number.isInteger(raw?.maxConcurrency) && (raw?.maxConcurrency ?? 0) >= 1 ? Number(raw?.maxConcurrency) : DEFAULT_PROMOTION_SCHEDULE.maxConcurrency,
    maxAttempts: Number.isInteger(raw?.maxAttempts) && (raw?.maxAttempts ?? 0) >= 1 ? Number(raw?.maxAttempts) : DEFAULT_PROMOTION_SCHEDULE.maxAttempts
  };
  parseClock(next.start);
  parseClock(next.end);
  assertValidTimeZone(next.timezone);
  if (!next.provider.trim() || !next.model.trim()) {
    throw new Error("provider and model are required");
  }
  return next;
}
function readZonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal")
      parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}
function zonedOffsetMs(instant, timeZone) {
  const parts = readZonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}
function zonedCivilToUtc(timeZone, year, month, day, hour, minute) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zonedOffsetMs(new Date(utcGuess), timeZone);
  let utc = utcGuess - offset;
  const offset2 = zonedOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset)
    utc = utcGuess - offset2;
  return utc;
}
function addCivilDays(year, month, day, delta) {
  const dt = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}
function localMinutes(nowMs, timeZone) {
  const parts = readZonedParts(new Date(nowMs), timeZone);
  return parts.hour * 60 + parts.minute;
}
function isInsidePromotionHours(nowMs, schedule) {
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  if (start === end)
    return false;
  const minutes = localMinutes(nowMs, schedule.timezone);
  if (start < end)
    return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}
function isInPromotionWindow(nowMs, schedule) {
  return schedule.enabled && isInsidePromotionHours(nowMs, schedule);
}
function nextWindowBoundary(nowMs, schedule) {
  if (!schedule.enabled)
    return;
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  if (start === end)
    return;
  const parts = readZonedParts(new Date(nowMs), schedule.timezone);
  const startHour = Math.floor(start / 60);
  const startMinute = start % 60;
  const endHour = Math.floor(end / 60);
  const endMinute = end % 60;
  const candidates = [];
  for (const delta of [-1, 0, 1, 2]) {
    const day = addCivilDays(parts.year, parts.month, parts.day, delta);
    candidates.push({
      at: zonedCivilToUtc(schedule.timezone, day.year, day.month, day.day, startHour, startMinute),
      entering: true
    });
    candidates.push({
      at: zonedCivilToUtc(schedule.timezone, day.year, day.month, day.day, endHour, endMinute),
      entering: false
    });
  }
  return candidates.filter((item) => item.at > nowMs).sort((a, b) => a.at - b.at)[0];
}
function promotionStatusView(schedule, nowMs) {
  const insideHours = isInsidePromotionHours(nowMs, schedule);
  const next = nextWindowBoundary(nowMs, schedule);
  return {
    ...schedule,
    modelSelector: promotionalModelSelector(schedule),
    insideHours,
    inWindow: schedule.enabled && insideHours,
    now: new Date(nowMs).toISOString(),
    ...next ? { nextBoundary: { at: new Date(next.at).toISOString(), entering: next.entering } } : {}
  };
}

// src/promotion-store.ts
import { existsSync as existsSync8, readFileSync as readFileSync5 } from "node:fs";

// src/json-file.ts
import { chmodSync as chmodSync3, mkdirSync as mkdirSync4, renameSync as renameSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname5 } from "node:path";
function atomicWriteJson2(path, data, mode = 384) {
  mkdirSync4(dirname5(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync3(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync3(tmp, path);
  try {
    chmodSync3(path, mode);
  } catch {}
}

// src/promotion-store.ts
class PromotionStore {
  rootDir;
  path;
  constructor(opts) {
    this.rootDir = opts?.rootDir ?? defaultOarRoot();
    this.path = oarPromotionPath(this.rootDir);
  }
  get() {
    return this.load().schedule;
  }
  set(schedule) {
    const normalized = normalizePromotionSchedule(schedule);
    const file = {
      version: 1,
      schedule: normalized,
      updatedAt: new Date().toISOString()
    };
    atomicWriteJson2(this.path, file, 384);
    return normalized;
  }
  load() {
    if (!existsSync8(this.path)) {
      return {
        version: 1,
        schedule: { ...DEFAULT_PROMOTION_SCHEDULE },
        updatedAt: new Date(0).toISOString()
      };
    }
    try {
      const parsed = JSON.parse(readFileSync5(this.path, "utf8"));
      if (parsed?.version !== 1 || !parsed.schedule) {
        return {
          version: 1,
          schedule: { ...DEFAULT_PROMOTION_SCHEDULE },
          updatedAt: new Date(0).toISOString()
        };
      }
      return {
        version: 1,
        schedule: normalizePromotionSchedule(parsed.schedule),
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString()
      };
    } catch {
      return {
        version: 1,
        schedule: { ...DEFAULT_PROMOTION_SCHEDULE },
        updatedAt: new Date(0).toISOString()
      };
    }
  }
}

// src/queue-manager.ts
import { existsSync as existsSync11 } from "node:fs";
import { join as join7, resolve } from "node:path";

// src/queue-runner.ts
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync as appendFileSync2, existsSync as existsSync9, mkdirSync as mkdirSync5, statSync, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname6, join as join5 } from "node:path";
var OAR_RESULT_DONE = "OAR_RESULT: DONE";
var OAR_RESULT_INCOMPLETE_PREFIX = "OAR_RESULT: INCOMPLETE:";
var OAR_BRAKE_MARKER = "omo-brake paused";
var OAR_BRAKE_EXHAUSTED_REASON = "omo-brake paused: attempts exhausted";
var QUEUE_COMPLETION_CONTRACT = [
  "----- OAR completion contract -----",
  "End your final message with exactly one sentinel line:",
  OAR_RESULT_DONE,
  "If you could not finish, end with exactly one sentinel line:",
  `${OAR_RESULT_INCOMPLETE_PREFIX} <reason>`,
  "Do not write anything after the sentinel line."
].join(`
`);
var QUEUE_CONTINUATION_PREAMBLE = "The previous attempt ended without completion. You must now finish the job and end with the sentinel.";
var QUEUE_FRESH_CONTINUATION_PREAMBLE = "The previous session is not being reused. Continue from the artifacts on disk and finish the job, then end with the sentinel.";
var QUEUE_SETUP_FAILURE_PREFIX = "setup_failed: ";
function setupFailureMessage(reason) {
  return `${QUEUE_SETUP_FAILURE_PREFIX}${reason}`;
}
function composeQueuePrompt(opts) {
  const parts = [];
  if (opts.continuation) {
    parts.push(opts.continuationKind === "fresh" ? QUEUE_FRESH_CONTINUATION_PREAMBLE : QUEUE_CONTINUATION_PREAMBLE);
    if (opts.priorReason)
      parts.push(`Prior result: ${opts.priorReason}`);
    parts.push("");
  }
  parts.push(opts.userPrompt);
  parts.push(QUEUE_COMPLETION_CONTRACT);
  return parts.join(`
`);
}
function buildOmoArgv(opts) {
  const args = [
    "--mode",
    "json",
    "--model",
    opts.modelSelector,
    "--no-model-fallback",
    "--no-ask-user"
  ];
  if (opts.sessionId) {
    args.push("--session", opts.sessionId);
  }
  args.push("-p");
  return args;
}
function inspectRepositoryPath(repository) {
  if (!repository)
    return { ok: false, error: "repository is required" };
  if (!existsSync9(repository))
    return { ok: false, error: `repository not found: ${repository}` };
  try {
    if (!statSync(repository).isDirectory()) {
      return { ok: false, error: `repository is not a directory: ${repository}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}
function inspectRepository(repository) {
  const path = inspectRepositoryPath(repository);
  if (!path.ok)
    return path;
  const inside = spawnSync("git", ["-C", repository, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8"
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return {
      ok: false,
      error: "Not a git repository; pass --isolate none to run in this directory."
    };
  }
  const head = spawnSync("git", ["-C", repository, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8"
  });
  if (head.status !== 0) {
    return { ok: false, error: "unsuitable repository: no commits" };
  }
  return { ok: true };
}
function addIsolatedWorktree(opts) {
  mkdirSync5(dirname6(opts.worktreeDir), { recursive: true, mode: 448 });
  if (existsSync9(opts.worktreeDir)) {
    return { ok: false, error: `worktree path already exists: ${opts.worktreeDir}` };
  }
  const added = spawnSync("git", ["-C", opts.repository, "worktree", "add", "--detach", opts.worktreeDir, "HEAD"], { encoding: "utf8" });
  if (added.status !== 0) {
    const detail = (added.stderr || added.stdout || "git worktree add failed").trim();
    return { ok: false, error: `worktree isolation failed: ${detail}` };
  }
  return { ok: true };
}
function writeSetupFailureArtifact(artifactDir, message) {
  try {
    mkdirSync5(artifactDir, { recursive: true, mode: 448 });
    writeFileSync4(join5(artifactDir, "setup-error.txt"), `${message}
`, {
      encoding: "utf8",
      mode: 384
    });
  } catch {}
}
function writePromptArtifacts(artifactDir, userPrompt, composed) {
  mkdirSync5(artifactDir, { recursive: true, mode: 448 });
  writeFileSync4(join5(artifactDir, "user-prompt.txt"), userPrompt, { encoding: "utf8", mode: 384 });
  writeFileSync4(join5(artifactDir, "prompt.txt"), composed, { encoding: "utf8", mode: 384 });
}
function terminateProcessTree(child, signal) {
  const pid = child.pid;
  if (pid == null)
    return;
  if (process.platform === "win32") {
    const force = signal === "SIGKILL";
    const args = force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
    try {
      spawn("taskkill", args, { stdio: "ignore" });
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseWorkerJsonStream(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{"))
      continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord3(parsed))
        events.push(parsed);
    } catch {}
  }
  return events;
}
function extractSessionId(stdout) {
  for (const event of parseWorkerJsonStream(stdout)) {
    if (event.type === "session" && typeof event.id === "string" && event.id.length > 0) {
      return event.id;
    }
  }
  return;
}
function assistantText(message) {
  const content = message.content;
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const item of content) {
    if (isRecord3(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("");
}
function considerAssistant(message, last) {
  if (message.role !== "assistant")
    return last;
  return {
    text: assistantText(message),
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined
  };
}
function extractLastAssistant(stdout) {
  let last;
  for (const event of parseWorkerJsonStream(stdout)) {
    if (isRecord3(event.message))
      last = considerAssistant(event.message, last);
    if (Array.isArray(event.messages)) {
      for (const item of event.messages) {
        if (isRecord3(item))
          last = considerAssistant(item, last);
      }
    }
    if (event.role === "assistant")
      last = considerAssistant(event, last);
  }
  return last;
}
function hasDoneSentinel(text) {
  return /(?:^|\n)OAR_RESULT: DONE(?:\r?\n|$)/.test(text);
}
function extractIncompleteReason(text) {
  const matches = [...text.matchAll(/(?:^|\n)OAR_RESULT: INCOMPLETE: ([^\r\n]*)/g)];
  const last = matches.at(-1);
  if (!last)
    return;
  const reason = (last[1] ?? "").trim();
  return reason.length > 0 ? reason : "incomplete";
}
function judgeQueueRun(result) {
  const sessionId = extractSessionId(result.stdout);
  const assistant = extractLastAssistant(result.stdout);
  if (result.code !== 0) {
    return {
      verdict: "failed",
      reason: result.signal ? `signal:${result.signal}` : `exit:${result.code ?? "unknown"}`,
      cause: result.signal ? "signal" : "exit",
      sessionId
    };
  }
  if (result.stdout.includes(OAR_BRAKE_MARKER)) {
    return { verdict: "incomplete", reason: OAR_BRAKE_MARKER, cause: "brake_paused", sessionId };
  }
  if (assistant && (assistant.stopReason === "error" || assistant.errorMessage)) {
    return {
      verdict: "incomplete",
      reason: assistant.errorMessage ? `provider_error: ${assistant.errorMessage}` : "provider_error",
      cause: "provider_error",
      sessionId
    };
  }
  const text = assistant?.text ?? "";
  if (hasDoneSentinel(text)) {
    return { verdict: "completed", reason: "done", cause: "done", sessionId };
  }
  const incomplete = extractIncompleteReason(text);
  if (incomplete !== undefined) {
    return { verdict: "incomplete", reason: incomplete, cause: "incomplete_sentinel", sessionId };
  }
  return { verdict: "incomplete", reason: "missing_sentinel", cause: "missing_sentinel", sessionId };
}
function createOmoQueueRunner(command = { bin: "omo" }) {
  const prefix = command.prefixArgs ?? [];
  return (req, signal) => {
    const composed = composeQueuePrompt({
      userPrompt: req.prompt,
      continuation: req.continuation,
      continuationKind: req.continuationKind,
      priorReason: req.priorReason
    });
    writePromptArtifacts(req.artifactDir, req.prompt, composed);
    const args = [
      ...prefix,
      ...buildOmoArgv({ modelSelector: req.modelSelector, sessionId: req.sessionId })
    ];
    writeFileSync4(join5(req.artifactDir, "argv.json"), JSON.stringify(args, null, 2), {
      encoding: "utf8",
      mode: 384
    });
    const stdoutPath = join5(req.artifactDir, "stdout.log");
    const stderrPath = join5(req.artifactDir, "stderr.log");
    writeFileSync4(stdoutPath, "", { encoding: "utf8", mode: 384 });
    writeFileSync4(stderrPath, "", { encoding: "utf8", mode: 384 });
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command.bin, args, {
          cwd: req.cwd,
          env: { ...process.env, OAR_QUEUE_JOB_ID: req.id },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32"
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      child.stdin?.on("error", () => {});
      try {
        child.stdin?.end(composed, "utf8");
      } catch {}
      let stdout = "";
      let stderr = "";
      let settled = false;
      let killTimer;
      const finish = (result) => {
        if (settled)
          return;
        settled = true;
        if (killTimer)
          clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        if (child.exitCode != null || child.signalCode != null)
          return;
        terminateProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) {
            terminateProcessTree(child, "SIGKILL");
          }
        }, 1000);
      };
      child.stdout?.on("data", (chunk) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stdout += text;
        appendFileSync2(stdoutPath, text);
      });
      child.stderr?.on("data", (chunk) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderr += text;
        appendFileSync2(stderrPath, text);
      });
      child.on("error", (error) => {
        if (settled)
          return;
        settled = true;
        if (killTimer)
          clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code, closeSignal) => {
        finish({ code, signal: closeSignal, stdout, stderr });
      });
      if (signal.aborted)
        onAbort();
      else
        signal.addEventListener("abort", onAbort);
    });
  };
}

// src/queue-store.ts
import { existsSync as existsSync10, readFileSync as readFileSync6 } from "node:fs";
import { join as join6 } from "node:path";
var QUEUE_ISOLATION_STRATEGIES = ["worktree", "none"];
var DEFAULT_QUEUE_ISOLATION = "worktree";
var DEFAULT_QUEUE_MAX_ATTEMPTS = 3;
function isQueueIsolation(value) {
  return typeof value === "string" && QUEUE_ISOLATION_STRATEGIES.includes(value);
}
function parseQueueIsolation(value) {
  if (value == null || value === "")
    return DEFAULT_QUEUE_ISOLATION;
  if (isQueueIsolation(value))
    return value;
  throw new Error(`unknown isolation strategy: ${String(value)} (use worktree or none)`);
}
function parseMaxAttempts(value) {
  if (value == null || value === "")
    return DEFAULT_QUEUE_MAX_ATTEMPTS;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("maxAttempts must be an integer >= 1");
  }
  return n;
}
function inferAttemptCause(record) {
  if (record.cause)
    return record.cause;
  if (record.verdict === "completed")
    return "done";
  if (record.reason === "missing_sentinel")
    return "missing_sentinel";
  if (record.reason === "omo-brake paused" || record.reason?.startsWith("omo-brake paused")) {
    return "brake_paused";
  }
  if (record.reason?.startsWith("provider_error"))
    return "provider_error";
  if (record.reason?.startsWith("setup_failed"))
    return "setup_failed";
  if (record.reason?.startsWith("signal:"))
    return "signal";
  if (record.reason?.startsWith("exit:"))
    return "exit";
  if (record.verdict === "incomplete")
    return "incomplete_sentinel";
  if (record.verdict === "failed")
    return "exit";
  return;
}
function shouldResumeQueueSession(previous) {
  return inferAttemptCause(previous ?? {}) === "incomplete_sentinel";
}
function parseDependsOn(value) {
  if (value == null || value === "")
    return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const seen = new Set;
  const out = [];
  for (const item of raw) {
    const id = String(item).trim();
    if (!id || seen.has(id))
      continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
function resolveQueueTaskRef(tasks, ref) {
  const token = ref.trim();
  if (!token)
    throw new Error("queue task id is required");
  const exact = tasks.find((task) => task.id === token);
  if (exact)
    return exact;
  const matches = tasks.filter((task) => task.id.startsWith(token));
  if (matches.length === 1)
    return matches[0];
  if (matches.length > 1)
    throw new Error(`ambiguous queue task id prefix: ${token}`);
  throw new Error(`unknown queue task ${token}`);
}
function resolveDependsOn(value, tasks, selfId) {
  const refs = parseDependsOn(value);
  const resolved = [];
  const seen = new Set;
  for (const ref of refs) {
    if (selfId && ref === selfId)
      throw new Error("cannot depend on itself");
    const task = resolveQueueTaskRef(tasks, ref);
    if (selfId && task.id === selfId)
      throw new Error("cannot depend on itself");
    if (seen.has(task.id))
      continue;
    seen.add(task.id);
    resolved.push(task.id);
  }
  return resolved;
}
var TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "incomplete"
]);
function isTerminalQueueStatus(status) {
  return TERMINAL.has(status);
}
function isSuccessfulQueueCompletion(task) {
  return task?.status === "completed" && task.verdict === "completed";
}
function evaluateQueueDependencies(task, tasks) {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  const unmetDependsOn = [];
  const reasons = [];
  for (const id of dependsOn) {
    const dep = byId.get(id);
    if (isSuccessfulQueueCompletion(dep))
      continue;
    unmetDependsOn.push(id);
    if (!dep) {
      reasons.push(`unsatisfiable_dependency: ${id} (unknown)`);
      continue;
    }
    if (isTerminalQueueStatus(dep.status) && dep.status !== "completed") {
      reasons.push(`unsatisfiable_dependency: ${id} (${dep.status})`);
      continue;
    }
    reasons.push(`unmet_dependency: ${id} (${dep.status})`);
  }
  return {
    dependsOn,
    unmetDependsOn,
    waiting: unmetDependsOn.length > 0,
    ready: unmetDependsOn.length === 0,
    ...reasons.length > 0 ? { reason: reasons.join("; ") } : {}
  };
}
function annotateQueueTask(task, tasks) {
  return { ...task, ...evaluateQueueDependencies(task, tasks) };
}
function annotateQueueTasks(tasks) {
  return tasks.map((task) => annotateQueueTask(task, tasks));
}
function isDependencyWaitReason(reason) {
  return typeof reason === "string" && (reason.startsWith("unmet_dependency:") || reason.startsWith("unsatisfiable_dependency:"));
}

class QueueStore {
  rootDir;
  path;
  constructor(opts) {
    this.rootDir = opts?.rootDir ?? defaultOarRoot();
    this.path = oarQueuePath(this.rootDir);
  }
  artifactDir(id) {
    return join6(oarQueueDir(this.rootDir), id);
  }
  attemptArtifactDir(id, attempt) {
    return join6(this.artifactDir(id), `attempt-${attempt}`);
  }
  list() {
    return this.load().tasks.map((task) => ({ ...task }));
  }
  get(id) {
    const task = this.load().tasks.find((item) => item.id === id);
    return task ? { ...task } : undefined;
  }
  resolve(ref) {
    return { ...resolveQueueTaskRef(this.list(), ref) };
  }
  nextQueued() {
    return this.listQueued()[0];
  }
  listQueued() {
    return this.list().filter((task) => task.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  add(input) {
    const prompt = input.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("prompt must be a non-empty string");
    }
    if (!input.repository)
      throw new Error("repository is required");
    const isolation = parseQueueIsolation(input.isolation);
    const maxAttempts = parseMaxAttempts(input.maxAttempts);
    const data = this.load();
    const id = crypto.randomUUID();
    const dependsOn = resolveDependsOn(input.dependsOn, data.tasks, id);
    const task = {
      id,
      prompt,
      repository: input.repository,
      isolation,
      status: "queued",
      maxAttempts,
      attempts: 0,
      sessionIds: [],
      attemptHistory: [],
      dependsOn,
      createdAt: new Date(input.nowMs).toISOString(),
      artifactDir: this.artifactDir(id)
    };
    data.tasks.push(task);
    this.save(data);
    return { ...task };
  }
  update(id, patch) {
    const data = this.load();
    const idx = data.tasks.findIndex((task) => task.id === id);
    if (idx < 0)
      throw new Error(`unknown queue task ${id}`);
    const current = data.tasks[idx];
    const next = { ...current, ...patch, id: current.id };
    data.tasks[idx] = next;
    this.save(data);
    return { ...next };
  }
  rearm(id) {
    const task = this.get(id);
    if (!task)
      throw new Error(`unknown queue task ${id}`);
    if (task.status !== "incomplete" && task.status !== "failed") {
      throw new Error(`cannot retry ${id} (${task.status})`);
    }
    return this.update(id, {
      status: "queued",
      attempts: 0,
      finishedAt: undefined,
      error: undefined,
      verdict: undefined,
      reason: undefined
    });
  }
  markStaleRunning(nowMs) {
    const data = this.load();
    const interrupted = [];
    const finishedAt = new Date(nowMs).toISOString();
    data.tasks = data.tasks.map((task) => {
      if (task.status !== "running")
        return task;
      const next = {
        ...task,
        status: "interrupted",
        finishedAt,
        error: task.error ?? "daemon_restart",
        reason: task.reason ?? "daemon_restart"
      };
      interrupted.push({ ...next });
      return next;
    });
    if (interrupted.length > 0)
      this.save(data);
    return interrupted;
  }
  load() {
    if (!existsSync10(this.path)) {
      return { version: 1, tasks: [], updatedAt: new Date(0).toISOString() };
    }
    try {
      const parsed = JSON.parse(readFileSync6(this.path, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) {
        return { version: 1, tasks: [], updatedAt: new Date(0).toISOString() };
      }
      return {
        version: 1,
        tasks: parsed.tasks.filter((task) => Boolean(task?.id && task.prompt && task.repository)).map((task) => normalizeLoadedTask(task)),
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString()
      };
    } catch {
      return { version: 1, tasks: [], updatedAt: new Date(0).toISOString() };
    }
  }
  save(data) {
    atomicWriteJson2(this.path, { ...data, updatedAt: new Date().toISOString() }, 384);
  }
}
function normalizeAttemptRecord(item) {
  const cause = inferAttemptCause(item);
  const sessionMode = item.sessionMode === "resume" ? "resume" : "fresh";
  return {
    ...item,
    sessionMode,
    ...cause ? { cause } : { cause: "missing_sentinel" }
  };
}
function normalizeLoadedTask(task) {
  const sessionIds = Array.isArray(task.sessionIds) ? task.sessionIds.filter((id) => typeof id === "string" && id.length > 0) : [];
  const attemptHistory = Array.isArray(task.attemptHistory) ? task.attemptHistory.filter((item) => item && typeof item.attempt === "number").map((item) => normalizeAttemptRecord(item)) : [];
  let maxAttempts = DEFAULT_QUEUE_MAX_ATTEMPTS;
  try {
    maxAttempts = parseMaxAttempts(task.maxAttempts);
  } catch {
    maxAttempts = DEFAULT_QUEUE_MAX_ATTEMPTS;
  }
  return {
    ...task,
    isolation: isQueueIsolation(task.isolation) ? task.isolation : DEFAULT_QUEUE_ISOLATION,
    maxAttempts,
    attempts: Number.isInteger(task.attempts) && (task.attempts ?? 0) >= 0 ? Number(task.attempts) : 0,
    sessionIds,
    attemptHistory,
    dependsOn: parseDependsOn(task.dependsOn)
  };
}

// src/queue-manager.ts
var OUTPUT_LIMIT = 8000;
var DEFAULT_QUEUE_RETRY_DELAY_MS = 250;
function defaultSleep(ms) {
  if (ms <= 0)
    return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class QueueManager {
  store;
  schedule;
  now;
  runner;
  isolateWorktree;
  emit;
  retryDelayMs;
  sleep;
  jobs = new Map;
  shuttingDown = false;
  constructor(opts) {
    this.store = opts.store;
    this.schedule = opts.schedule;
    this.now = opts.now;
    this.runner = opts.runner;
    this.isolateWorktree = opts.isolateWorktree ?? addIsolatedWorktree;
    this.emit = opts.emit;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_QUEUE_RETRY_DELAY_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }
  runningCount() {
    return this.jobs.size;
  }
  markStaleRunning() {
    const interrupted = this.store.markStaleRunning(this.now());
    for (const task of interrupted) {
      this.emit({ type: "queue:job-finished", id: task.id, status: "interrupted" });
    }
    return interrupted;
  }
  async reconcile() {
    if (this.shuttingDown)
      return;
    const inWindow = isInPromotionWindow(this.now(), this.schedule());
    if (!inWindow) {
      await this.interruptAll("outside_window");
      return;
    }
    this.fillSlots();
  }
  async cancel(id) {
    const task = this.store.resolve(id);
    if (task.status === "queued") {
      const cancelled = this.store.update(task.id, {
        status: "cancelled",
        finishedAt: new Date(this.now()).toISOString(),
        error: "cancelled",
        reason: "cancelled"
      });
      this.refreshDependencyReasons();
      return cancelled;
    }
    if (task.status === "running") {
      await this.abortJob(task.id, "cancel");
      this.refreshDependencyReasons();
      const latest = this.store.get(task.id);
      if (!latest)
        throw new Error(`unknown queue task ${id}`);
      return latest;
    }
    throw new Error(`cannot cancel ${task.id} (${task.status})`);
  }
  async retry(id) {
    const resolved = this.store.resolve(id);
    const rearmed = this.store.rearm(resolved.id);
    await this.reconcile();
    return this.store.get(resolved.id) ?? rearmed;
  }
  async shutdown() {
    this.shuttingDown = true;
    await this.interruptAll("daemon_stop");
  }
  resetLifecycle() {
    this.shuttingDown = false;
  }
  refreshDependencyReasons() {
    const snapshot = this.store.list();
    for (const task of snapshot) {
      if (task.status !== "queued")
        continue;
      this.recordDependencyState(task, evaluateQueueDependencies(task, snapshot));
    }
  }
  fillSlots() {
    if (this.shuttingDown)
      return;
    const cap = this.schedule().maxConcurrency;
    const snapshot = this.store.list();
    const queued = snapshot.filter((task) => task.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const task of queued) {
      if (this.jobs.size >= cap)
        break;
      if (!isInPromotionWindow(this.now(), this.schedule()))
        return;
      if (this.jobs.has(task.id))
        continue;
      const gate = evaluateQueueDependencies(task, snapshot);
      this.recordDependencyState(task, gate);
      if (!gate.ready)
        continue;
      if (!this.launch(task))
        break;
    }
  }
  recordDependencyState(task, gate) {
    if (task.status !== "queued")
      return;
    if (gate.ready) {
      if (isDependencyWaitReason(task.reason)) {
        this.store.update(task.id, { reason: undefined, error: undefined });
      }
      return;
    }
    if (task.reason === gate.reason)
      return;
    this.store.update(task.id, {
      reason: gate.reason,
      error: gate.reason
    });
  }
  launch(task) {
    if (this.shuttingDown || !isInPromotionWindow(this.now(), this.schedule()))
      return false;
    const abort = new AbortController;
    const handle = { abort, done: Promise.resolve() };
    this.jobs.set(task.id, handle);
    const nextAttempt = (task.attempts ?? 0) + 1;
    const baseDir = task.artifactDir ?? this.store.artifactDir(task.id);
    this.store.update(task.id, {
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
      attempts: nextAttempt,
      artifactDir: baseDir,
      ...isDependencyWaitReason(task.reason) ? { reason: undefined, error: undefined } : {}
    });
    this.emit({ type: "queue:job-started", id: task.id });
    handle.done = this.run(task.id, handle).finally(() => {
      this.jobs.delete(task.id);
      if (!this.shuttingDown && isInPromotionWindow(this.now(), this.schedule())) {
        this.fillSlots();
      }
    });
    return true;
  }
  async run(id, handle) {
    const task = this.store.get(id);
    if (!task)
      return;
    const baseDir = task.artifactDir ?? this.store.artifactDir(id);
    const attemptNo = task.attempts > 0 ? task.attempts : 1;
    const attemptDir = this.store.attemptArtifactDir(id, attemptNo);
    const finishAbort = (status, extra) => {
      this.store.update(id, {
        status,
        finishedAt: new Date(this.now()).toISOString(),
        ...extra?.output != null ? { output: extra.output } : {},
        ...extra?.error != null ? { error: extra.error, reason: extra.error } : {}
      });
      this.emit({ type: "queue:job-finished", id, status });
    };
    const finishSetupFailure = (message) => {
      if (handle.reason) {
        finishAbort(statusForAbort(handle.reason), { error: handle.reason });
        return;
      }
      writeSetupFailureArtifact(attemptDir, message);
      const outcome = this.recordAttempt(id, attemptDir, { code: 1, signal: null, stdout: "", stderr: message }, task.startedAt, { verdict: "failed", reason: setupFailureMessage(message), cause: "setup_failed" }, "fresh");
      if (outcome.canRetry)
        this.sleep(this.retryDelayMs);
    };
    try {
      if (this.shouldStop(handle)) {
        const reason = handle.reason ?? abortReasonNow(handle, this.now, this.schedule);
        finishAbort(statusForAbort(reason), { error: reason });
        return;
      }
      const isolation = task.isolation ?? DEFAULT_QUEUE_ISOLATION;
      const repo = isolation === "none" ? inspectRepositoryPath(task.repository) : inspectRepository(task.repository);
      if (!repo.ok) {
        finishSetupFailure(repo.error);
        return;
      }
      if (this.shouldStop(handle)) {
        const reason = handle.reason ?? abortReasonNow(handle, this.now, this.schedule);
        finishAbort(statusForAbort(reason), { error: reason });
        return;
      }
      let cwd = resolve(task.repository);
      if (isolation === "worktree") {
        const worktreeDir = task.worktreeDir ?? join7(baseDir, "work");
        if (!task.worktreeDir || !existsSync11(worktreeDir)) {
          const isolated = this.isolateWorktree({ repository: resolve(task.repository), worktreeDir });
          if (!isolated.ok) {
            finishSetupFailure(isolated.error);
            return;
          }
        }
        if (this.shouldStop(handle)) {
          const reason = handle.reason ?? abortReasonNow(handle, this.now, this.schedule);
          finishAbort(statusForAbort(reason), { error: reason });
          return;
        }
        this.store.update(id, { worktreeDir, artifactDir: baseDir });
        cwd = worktreeDir;
      }
      if (this.shouldStop(handle)) {
        const reason = handle.reason ?? abortReasonNow(handle, this.now, this.schedule);
        finishAbort(statusForAbort(reason), { error: reason });
        return;
      }
      const latest = this.store.get(id) ?? task;
      const previous = latest.attemptHistory.at(-1);
      const continuation = latest.attemptHistory.length > 0;
      const resume = continuation && shouldResumeQueueSession(previous);
      const sessionMode = resume ? "resume" : "fresh";
      const sessionId = resume ? previous?.sessionId ?? latest.sessionIds.at(-1) : undefined;
      const schedule = this.schedule();
      const result = await this.runner({
        id,
        prompt: latest.prompt,
        cwd,
        modelSelector: promotionalModelSelector(schedule),
        artifactDir: attemptDir,
        sessionId,
        continuation,
        continuationKind: continuation ? sessionMode : undefined,
        priorReason: latest.reason
      }, handle.abort.signal);
      if (handle.reason) {
        finishAbort(statusForAbort(handle.reason), {
          output: clipOutput(result.stdout, result.stderr),
          error: handle.reason
        });
        return;
      }
      const recorded = this.recordAttempt(id, attemptDir, result, latest.startedAt, undefined, sessionMode);
      if (recorded.canRetry && !this.shouldStop(handle)) {
        await this.sleep(this.retryDelayMs);
      }
    } catch (error) {
      if (handle.reason) {
        finishAbort(statusForAbort(handle.reason), {
          error: handle.reason
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const recorded = this.recordAttempt(id, attemptDir, { code: 1, signal: null, stdout: "", stderr: message }, task.startedAt, { verdict: "failed", reason: message, cause: "exit" }, "fresh");
      if (recorded.canRetry && !this.shouldStop(handle)) {
        await this.sleep(this.retryDelayMs);
      }
    }
  }
  recordAttempt(id, attemptDir, result, startedAt, override, sessionMode = "fresh") {
    const task = this.store.get(id);
    if (!task)
      return { canRetry: false };
    const judged = override ?? judgeQueueRun(result);
    const sessionId = judged.sessionId;
    const sessionIds = sessionId ? [...task.sessionIds, sessionId] : [...task.sessionIds];
    const finishedAt = new Date(this.now()).toISOString();
    const record = {
      attempt: task.attempts,
      ...sessionId ? { sessionId } : {},
      sessionMode,
      cause: judged.cause,
      verdict: judged.verdict,
      reason: judged.reason,
      artifactDir: attemptDir,
      startedAt: startedAt ?? finishedAt,
      finishedAt
    };
    const attemptHistory = [...task.attemptHistory, record];
    const maxAttempts = task.maxAttempts ?? DEFAULT_QUEUE_MAX_ATTEMPTS;
    const retryable = judged.verdict === "incomplete" || judged.verdict === "failed";
    const canRetry = retryable && task.attempts < maxAttempts;
    const brakeCount = attemptHistory.filter((item) => item.cause === "brake_paused").length;
    const reason = !canRetry && judged.cause === "brake_paused" && brakeCount >= 2 ? OAR_BRAKE_EXHAUSTED_REASON : judged.reason;
    if (reason !== record.reason) {
      record.reason = reason;
    }
    const status = judged.verdict === "completed" ? "completed" : canRetry ? "queued" : judged.verdict;
    this.store.update(id, {
      status,
      verdict: judged.verdict,
      reason,
      sessionIds,
      attemptHistory,
      artifactDir: task.artifactDir ?? this.store.artifactDir(id),
      output: clipOutput(result.stdout, result.stderr),
      error: judged.verdict === "completed" ? undefined : reason,
      finishedAt
    });
    this.emit({ type: "queue:job-finished", id, status: canRetry ? judged.verdict : status });
    return { canRetry };
  }
  shouldStop(handle) {
    if (handle.abort.signal.aborted || this.shuttingDown)
      return true;
    if (!isInPromotionWindow(this.now(), this.schedule())) {
      handle.reason = handle.reason ?? "outside_window";
      if (!handle.abort.signal.aborted)
        handle.abort.abort();
      return true;
    }
    return false;
  }
  async interruptAll(reason) {
    const ids = [...this.jobs.keys()];
    await Promise.all(ids.map((id) => this.abortJob(id, reason)));
  }
  async abortJob(id, reason) {
    const job = this.jobs.get(id);
    if (!job)
      return;
    job.reason = reason;
    if (!job.abort.signal.aborted)
      job.abort.abort();
    await job.done;
  }
}
function abortReasonNow(handle, now, schedule) {
  if (handle.reason)
    return handle.reason;
  if (!isInPromotionWindow(now(), schedule()))
    return "outside_window";
  return "daemon_stop";
}
function statusForAbort(reason) {
  return reason === "cancel" ? "cancelled" : "interrupted";
}
function clipOutput(stdout, stderr) {
  const text = [stdout, stderr].filter((part) => part.length > 0).join(`
`);
  if (text.length <= OUTPUT_LIMIT)
    return text;
  return text.slice(0, OUTPUT_LIMIT);
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

// src/report-results.ts
var REPORT_RESULTS = [
  "SUCCESS",
  "QUOTA_AVAILABLE",
  "QUOTA_UNKNOWN",
  "AUTH_EXPIRED",
  "AUTH_REVOKED",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "BAD_REQUEST",
  "INVALID_ARGUMENT",
  "MODEL_NOT_FOUND",
  "PROMPT_ERROR",
  "TOOL_ERROR",
  "LOCAL_ERROR",
  "UNKNOWN"
];
var REPORT_RESULT_SET = new Set(REPORT_RESULTS);
function isReportResult(value) {
  return REPORT_RESULT_SET.has(value);
}
function parseReportResult(value) {
  if (!isReportResult(value)) {
    throw new Error(`invalid report result: ${value}
` + `expected one of: ${REPORT_RESULTS.join(", ")}`);
  }
  return value;
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
  if (a.availability === "QUOTA_EXHAUSTED") {
    return false;
  }
  if (a.availability === "QUOTA_UNKNOWN") {
    return false;
  }
  if ((a.availability === "COOLDOWN" || a.availability === "RATE_LIMITED") && a.until) {
    if (Date.parse(a.until) > now)
      return false;
  } else if (a.availability === "COOLDOWN" || a.availability === "RATE_LIMITED" || a.availability === "AUTH_EXPIRED") {
    return false;
  }
  return ELIGIBLE.includes(a.availability) || a.availability === "UNKNOWN";
}
function isManualUnreportedUsable(a) {
  return a.auth === "valid" && a.availability === "QUOTA_UNKNOWN" && a.reason === "remote_usage_unreported" && !a.disabled;
}
function refuseReason(account) {
  if (account.availability === "QUOTA_EXHAUSTED") {
    return `quota exhausted (0% / limit)${account.until ? `; resets ~ ${account.until}` : ""}`;
  }
  if (account.availability === "QUOTA_UNKNOWN") {
    return "remote quota unknown — verification required";
  }
  if (account.availability === "RATE_LIMITED") {
    return `rate limited${account.until ? `; until ${account.until}` : ""}`;
  }
  if (account.availability === "AUTH_REVOKED" || account.auth === "revoked") {
    return "auth revoked — re-login required";
  }
  if (account.availability === "AUTH_EXPIRED" || account.auth === "expired") {
    return "auth expired — refresh/login required";
  }
  if (account.disabled || account.availability === "DISABLED") {
    return "account disabled";
  }
  return account.reason ?? account.availability;
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
    if (policy.preferred) {
      const preferred = accounts.find((a) => a.profile === policy.preferred);
      if (preferred && isEligible(preferred)) {
        return this.toResponse(preferred);
      }
      if (preferred && isManualUnreportedUsable(preferred) && policy.mode === "manual" && !policy.autoFailover) {
        return this.toResponse(preferred);
      }
      if (preferred && !isEligible(preferred) && policy.mode === "manual" && !policy.autoFailover) {
        return {
          provider: req.provider,
          profile: preferred.profile,
          status: "unavailable",
          availability: preferred.availability,
          reason: refuseReason(preferred)
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
      const preferred = policy.preferred ? accounts.find((a) => a.profile === policy.preferred) : undefined;
      const anyRevoked = accounts.every((a) => a.availability === "AUTH_REVOKED" || a.availability === "REQUIRES_LOGIN");
      return {
        provider: req.provider,
        profile: preferred?.profile ?? accounts[0]?.profile ?? "",
        status: "unavailable",
        availability: preferred?.availability ?? (anyRevoked ? "REQUIRES_LOGIN" : "QUOTA_EXHAUSTED"),
        reason: preferred ? refuseReason(preferred) : "no_eligible_accounts"
      };
    }
    return this.toResponse(pick);
  }
  use(provider, profile, opts) {
    const account = this.store.getAccount(provider, profile);
    if (!account) {
      throw new Error(`Unknown account ${provider}/${profile}`);
    }
    const allowUnreportedManual = isManualUnreportedUsable(account);
    if (!opts?.force && !isEligible(account) && !allowUnreportedManual) {
      throw new Error(`REFUSED: ${provider}/${profile} is not usable — ${refuseReason(account)}. ` + `Not switching (even if auto is on). Pass force to override.`);
    }
    this.store.setPreferred(provider, profile);
    this.store.upsertAccount({
      ...account,
      lastUsedAt: new Date().toISOString()
    });
    if (opts?.force || allowUnreportedManual) {
      return this.toResponse(this.store.getAccount(provider, profile) ?? account);
    }
    return this.resolve({ provider });
  }
  setMode(provider, mode) {
    this.store.setProviderMode(provider, mode);
  }
  reportResult(req) {
    const account = this.store.getAccount(req.provider, req.account);
    if (!account)
      return;
    if (req.result === "QUOTA_AVAILABLE") {
      const next = {
        ...account,
        auth: "valid",
        availability: "AVAILABLE",
        reason: undefined,
        until: null,
        lastChecked: new Date().toISOString()
      };
      this.store.upsertAccount(next);
      return next;
    }
    if (req.result === "QUOTA_UNKNOWN") {
      const next = {
        ...account,
        auth: "valid",
        availability: "QUOTA_UNKNOWN",
        reason: req.detail ?? "remote_usage_unreported",
        until: null,
        lastChecked: new Date().toISOString()
      };
      this.store.upsertAccount(next);
      return next;
    }
    if (req.result === "SUCCESS") {
      if (account.availability === "QUOTA_UNKNOWN" && account.reason === "remote_usage_unreported") {
        const kept = {
          ...account,
          lastChecked: new Date().toISOString(),
          lastUsedAt: new Date().toISOString()
        };
        this.store.upsertAccount(kept);
        return kept;
      }
      if (account.availability === "QUOTA_EXHAUSTED") {
        const kept = {
          ...account,
          lastChecked: new Date().toISOString(),
          lastUsedAt: new Date().toISOString()
        };
        this.store.upsertAccount(kept);
        return kept;
      }
      const next = {
        ...account,
        auth: "valid",
        availability: "AVAILABLE",
        reason: undefined,
        until: null,
        lastChecked: new Date().toISOString(),
        lastUsedAt: new Date().toISOString()
      };
      this.store.upsertAccount(next);
      return next;
    }
    const failure = req.result;
    const next = {
      ...account,
      lastChecked: new Date().toISOString(),
      reason: req.detail ?? failure
    };
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
      case "QUOTA_UNKNOWN":
        next.auth = "valid";
        next.availability = "QUOTA_UNKNOWN";
        next.until = null;
        break;
      case "NETWORK_ERROR":
      case "SERVER_ERROR":
      case "BAD_REQUEST":
      case "INVALID_ARGUMENT":
      case "MODEL_NOT_FOUND":
      case "PROMPT_ERROR":
      case "TOOL_ERROR":
      case "LOCAL_ERROR":
      case "UNKNOWN":
        this.store.upsertAccount(next);
        return next;
      default:
        this.store.upsertAccount(next);
        return next;
    }
    this.store.upsertAccount(next);
    const policy = this.store.getProviderPolicy(req.provider);
    if (failure !== "QUOTA_UNKNOWN" && policy.autoFailover && isAccountFailoverCandidate(failure) && policy.mode === "auto") {}
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

// src/usage/cache.ts
import { existsSync as existsSync12, mkdirSync as mkdirSync6, readFileSync as readFileSync7, renameSync as renameSync4, writeFileSync as writeFileSync5, chmodSync as chmodSync4 } from "node:fs";
import { dirname as dirname7, join as join8 } from "node:path";
function usageCachePath(root = defaultOarRoot()) {
  return join8(root, "usage-cache.json");
}
function cacheKey(provider, profile) {
  return `${provider}/${profile}`;
}
function loadUsageCache(root = defaultOarRoot()) {
  const path = usageCachePath(root);
  if (!existsSync12(path))
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: {} };
  try {
    const parsed = JSON.parse(readFileSync7(path, "utf8"));
    if (parsed?.version !== 1 || !parsed.entries) {
      return { version: 1, updatedAt: new Date(0).toISOString(), entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: {} };
  }
}
function saveUsageCache(cache, root = defaultOarRoot()) {
  const path = usageCachePath(root);
  mkdirSync6(dirname7(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: cache.entries
  };
  writeFileSync5(tmp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 384 });
  renameSync4(tmp, path);
  try {
    chmodSync4(path, 384);
  } catch {}
}
function getCachedUsage(provider, profile, opts) {
  const root = opts?.root ?? defaultOarRoot();
  const maxAgeMs = opts?.maxAgeMs ?? 60000;
  const cache = loadUsageCache(root);
  const entry = cache.entries[cacheKey(provider, profile)];
  if (!entry)
    return;
  const age = Date.now() - Date.parse(entry.fetchedAt);
  if (!Number.isFinite(age) || age > maxAgeMs)
    return;
  return entry;
}
function putCachedUsage(entry, root = defaultOarRoot()) {
  const cache = loadUsageCache(root);
  cache.entries[cacheKey(entry.provider, entry.profile)] = entry;
  saveUsageCache(cache, root);
}

// src/import-all.ts
import { readFileSync as readFileSync8 } from "node:fs";
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStoredCredential(value) {
  if (!isRecord4(value))
    return false;
  if (value.type === "oauth") {
    if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") {
      return false;
    }
    if (value.accountId !== undefined && typeof value.accountId !== "string")
      return false;
    if (value.idToken !== undefined && typeof value.idToken !== "string")
      return false;
    return true;
  }
  if (value.type === "api_key") {
    return typeof value.key === "string";
  }
  return false;
}
function parseAuthJsonFile(authPath) {
  let raw;
  try {
    raw = readFileSync8(authPath, "utf8");
  } catch {
    throw new Error(`unable to read ${authPath}`);
  }
  try {
    const data = JSON.parse(raw);
    if (!isRecord4(data))
      throw new Error("invalid auth.json");
    return data;
  } catch {
    throw new Error(`invalid auth.json: ${authPath}`);
  }
}
function expiresFromAccessJwt(access) {
  const payload = decodeJwtPayload(access);
  const exp = payload?.exp;
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
    return exp * 1000;
  }
  return;
}
function accountIdFromIdToken(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload)
    return;
  const auth = payload["https://api.openai.com/auth"];
  if (isRecord4(auth)) {
    const id = auth.chatgpt_account_id;
    if (typeof id === "string" && id.length > 0)
      return id;
  }
  if (typeof payload.chatgpt_account_id === "string" && payload.chatgpt_account_id.length > 0) {
    return payload.chatgpt_account_id;
  }
  return;
}
function credentialFromNativeCodexAuth(data) {
  if (!isRecord4(data))
    return;
  const tokens = data.tokens;
  if (!isRecord4(tokens))
    return;
  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  if (typeof access !== "string" || access.length === 0)
    return;
  if (typeof refresh !== "string" || refresh.length === 0)
    return;
  const idToken = typeof tokens.id_token === "string" && tokens.id_token.length > 0 ? tokens.id_token : undefined;
  let accountId = typeof tokens.account_id === "string" && tokens.account_id.length > 0 ? tokens.account_id : undefined;
  if (!accountId && idToken)
    accountId = accountIdFromIdToken(idToken);
  const expires = expiresFromAccessJwt(access) ?? 0;
  return {
    type: "oauth",
    access,
    refresh,
    expires,
    ...accountId ? { accountId } : {},
    ...idToken ? { idToken } : {}
  };
}
function readCredentialFromAuthJson(authPath, provider, opts) {
  const data = parseAuthJsonFile(authPath);
  for (const key of authJsonKeysForProvider(provider)) {
    const slot = data[key];
    if (!isStoredCredential(slot))
      continue;
    return selectImportAccount(slot, provider, authPath, opts?.account ?? "latest").credential;
  }
  if (provider === "openai-codex" || provider === "chatgpt-subscription") {
    const native = credentialFromNativeCodexAuth(data);
    if (native)
      return native;
  }
  return missingProvider(data, provider, authPath);
}
function missingProvider(data, provider, authPath) {
  const available = Object.keys(data).filter((key) => isStoredCredential(data[key]));
  const looked = authJsonKeysForProvider(provider).join(", ");
  throw new Error(`provider ${provider} not found in ${authPath} (looked for ${looked}; available: ${available.join(", ") || "none"})`);
}
function latestLoginSlotName(linked) {
  let best = 0;
  let name;
  for (const item of linked) {
    if (!isRecord4(item) || typeof item.name !== "string")
      continue;
    const match = /^login-(\d+)$/.exec(item.name);
    if (!match)
      continue;
    const n = Number(match[1]);
    if (n > best) {
      best = n;
      name = item.name;
    }
  }
  return name;
}
function credentialFromSlotEntry(parent, entry) {
  if (isStoredCredential(entry))
    return entry;
  if (!isRecord4(entry) || parent.type !== "oauth" || typeof entry.access !== "string") {
    throw new Error("selected accounts[] entry is not a credential");
  }
  const refresh = typeof entry.refresh === "string" ? entry.refresh : parent.refresh;
  const expires = typeof entry.expires === "number" ? entry.expires : parent.expires;
  return {
    type: "oauth",
    access: entry.access,
    refresh,
    expires,
    ...parent.accountId ? { accountId: parent.accountId } : {},
    ...typeof entry.idToken === "string" ? { idToken: entry.idToken } : parent.idToken ? { idToken: parent.idToken } : {}
  };
}
function selectImportAccount(slot, provider, authPath, account = "latest") {
  if (account === "primary")
    return { used: "primary", credential: slot };
  const linked = slot.accounts;
  if (account === "latest") {
    const name = Array.isArray(linked) ? latestLoginSlotName(linked) : undefined;
    if (!name)
      return { used: "primary", credential: slot };
    return { used: name, credential: selectLinkedAccount(slot, provider, authPath, name) };
  }
  return { used: account, credential: selectLinkedAccount(slot, provider, authPath, account) };
}
function selectLinkedAccount(slot, provider, authPath, account) {
  const linked = slot.accounts;
  if (!Array.isArray(linked) || linked.length === 0) {
    throw new Error(`${provider} in ${authPath} has no accounts[] array; --account cannot be applied`);
  }
  const selected = account === "latest" ? latestLoginSlotName(linked) : account;
  if (!selected) {
    throw new Error(`${provider} in ${authPath} has no login-N slot to use as latest`);
  }
  const idx = /^\d+$/.test(selected) ? Number(selected) - 1 : linked.findIndex((a) => {
    return isRecord4(a) && a["name"] === selected;
  });
  if (idx < 0 || idx >= linked.length) {
    const names = linked.map((a, i) => isRecord4(a) && typeof a["name"] === "string" ? `${i + 1}=${a["name"]}` : `${i + 1}`).join(", ");
    throw new Error(`--account ${account} not found in ${provider} accounts[] (available: ${names})`);
  }
  return credentialFromSlotEntry(slot, linked[idx]);
}

// src/usage/codex.ts
var WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
function remaining(used) {
  if (used == null || !Number.isFinite(used))
    return null;
  return Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10));
}
function kindFromSeconds(seconds) {
  if (seconds == null || !Number.isFinite(seconds))
    return "other";
  if (seconds <= 6 * 3600)
    return "session";
  if (seconds >= 6 * 24 * 3600)
    return "weekly";
  return "other";
}
function windowFromWham(raw, label) {
  if (!raw || typeof raw !== "object")
    return null;
  const w = raw;
  const usedRaw = w.used_percent ?? w.usedPercent;
  const used = typeof usedRaw === "number" && Number.isFinite(usedRaw) ? usedRaw : null;
  const secRaw = w.limit_window_seconds ?? w.windowDurationMins;
  let windowSeconds = null;
  if (typeof w.limit_window_seconds === "number")
    windowSeconds = w.limit_window_seconds;
  else if (typeof w.windowDurationMins === "number")
    windowSeconds = w.windowDurationMins * 60;
  const resetAtRaw = w.reset_at ?? w.resetsAt;
  let resetsAt = null;
  if (typeof resetAtRaw === "number" && Number.isFinite(resetAtRaw)) {
    resetsAt = new Date(resetAtRaw * (resetAtRaw < 1000000000000 ? 1000 : 1)).toISOString();
  } else if (typeof resetAtRaw === "string") {
    resetsAt = resetAtRaw;
  }
  const kind = kindFromSeconds(windowSeconds);
  return {
    kind,
    usedPercent: used,
    remainingPercent: remaining(used),
    resetsAt,
    windowSeconds,
    label: label ?? (kind === "session" ? "5h" : kind === "weekly" ? "week" : "window"),
    limitReached: Boolean(w.limit_reached ?? w.limitReached)
  };
}
async function fetchCodexUsage(provider, profile, credential, opts) {
  const fetchedAt = new Date().toISOString();
  if (credential.type !== "oauth") {
    return {
      provider,
      profile,
      source: "codex-wham",
      fetchedAt,
      ok: false,
      error: "codex usage requires oauth credential",
      windows: []
    };
  }
  const headers = {
    Authorization: `Bearer ${credential.access}`,
    Accept: "application/json",
    "User-Agent": "omo-account-router/0.1"
  };
  const accountId = credential.accountId ?? (credential.idToken ? accountIdFromIdToken(credential.idToken) : undefined);
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(WHAM_USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        provider,
        profile,
        source: "codex-wham",
        fetchedAt,
        ok: false,
        error: `HTTP ${response.status}`,
        windows: [],
        extras: {
          httpStatus: response.status,
          ...response.status === 401 ? { diagnostic: "chatgpt-wham-unauthorized" } : {}
        }
      };
    }
    let data = {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed;
      }
    } catch {
      return {
        provider,
        profile,
        source: "codex-wham",
        fetchedAt,
        ok: false,
        error: `invalid JSON (HTTP ${response.status})`,
        windows: [],
        extras: { httpStatus: response.status }
      };
    }
    const windows = [];
    const rateLimit = data.rate_limit;
    if (rateLimit && typeof rateLimit === "object") {
      const rl = rateLimit;
      const primary = windowFromWham(rl.primary_window);
      if (primary)
        windows.push(primary);
      const secondary = windowFromWham(rl.secondary_window);
      if (secondary)
        windows.push(secondary);
    }
    const additional = data.additional_rate_limits;
    if (Array.isArray(additional)) {
      for (const item of additional) {
        if (!item || typeof item !== "object")
          continue;
        const row = item;
        const name = typeof row.limit_name === "string" ? row.limit_name : "extra";
        const nested = row.rate_limit;
        if (nested && typeof nested === "object") {
          const n = nested;
          const w = windowFromWham(n.primary_window, name);
          if (w)
            windows.push(w);
        }
      }
    }
    return {
      provider,
      profile,
      source: "codex-wham",
      fetchedAt,
      ok: true,
      windows,
      extras: {
        limitReached: Boolean(rateLimit && typeof rateLimit === "object" && rateLimit.limit_reached)
      }
    };
  } catch (error) {
    return {
      provider,
      profile,
      source: "codex-wham",
      fetchedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      windows: []
    };
  }
}

// src/usage/xai-grok.ts
var GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
function isGrokCreditsExhaustedHttp(status, body) {
  if (status !== 402 && status !== 403)
    return false;
  const text = body.toLowerCase();
  return text.includes("run out of credits") || text.includes("need a grok subscription") || text.includes("add credits");
}
function remaining2(used) {
  if (used == null || !Number.isFinite(used))
    return null;
  return Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10));
}
function moneyVal(raw) {
  if (typeof raw === "number" && Number.isFinite(raw))
    return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const val = raw.val;
    if (typeof val === "number" && Number.isFinite(val))
      return val;
  }
  return null;
}
function roundPercent(n) {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}
async function fetchXaiGrokSubscriptionUsage(provider, profile, credential, opts) {
  const fetchedAt = new Date().toISOString();
  if (credential.type !== "oauth") {
    return {
      provider,
      profile,
      source: "grok-billing",
      fetchedAt,
      ok: false,
      error: "xai grok subscription usage requires oauth credential",
      windows: []
    };
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(GROK_BILLING_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "x-xai-token-auth": "xai-grok-cli",
        Accept: "application/json",
        "User-Agent": "GrokCLI/1.0.4"
      },
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    if (!response.ok) {
      if (isGrokCreditsExhaustedHttp(response.status, text)) {
        return {
          provider,
          profile,
          source: "grok-billing",
          fetchedAt,
          ok: true,
          windows: [
            {
              kind: "period",
              usedPercent: 100,
              remainingPercent: 0,
              label: "grok",
              limitReached: true
            }
          ],
          extras: {
            httpStatus: response.status,
            diagnostic: "grok-credits-exhausted",
            unreported: false,
            entitlementExhausted: true
          }
        };
      }
      return {
        provider,
        profile,
        source: "grok-billing",
        fetchedAt,
        ok: false,
        error: `HTTP ${response.status}`,
        windows: [],
        extras: { httpStatus: response.status }
      };
    }
    let data = {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed;
      }
    } catch {
      return {
        provider,
        profile,
        source: "grok-billing",
        fetchedAt,
        ok: false,
        error: `invalid JSON (HTTP ${response.status})`,
        windows: [],
        extras: { httpStatus: response.status }
      };
    }
    const config = data.config && typeof data.config === "object" ? data.config : data;
    const isUnifiedBillingUser = config.isUnifiedBillingUser === true;
    const creditUsed = typeof config.creditUsagePercent === "number" && Number.isFinite(config.creditUsagePercent) ? config.creditUsagePercent : null;
    const onDemandCap = moneyVal(config.onDemandCap);
    const onDemandUsed = moneyVal(config.onDemandUsed);
    const prepaidBalance = moneyVal(config.prepaidBalance);
    let used = creditUsed;
    let limitReached = false;
    let unreported = false;
    let entitlementExhausted = false;
    if (used == null) {
      if (onDemandCap === 0) {
        if (isUnifiedBillingUser) {
          unreported = true;
        } else {
          used = 100;
          limitReached = true;
          entitlementExhausted = true;
        }
      } else if (onDemandCap != null && onDemandCap > 0 && onDemandUsed != null) {
        used = roundPercent(onDemandUsed / onDemandCap * 100);
        limitReached = onDemandUsed >= onDemandCap;
        entitlementExhausted = limitReached;
      } else {
        unreported = true;
      }
    } else {
      limitReached = used >= 100;
      entitlementExhausted = limitReached;
    }
    const period = config.currentPeriod;
    let resetsAt = null;
    let windowSeconds = null;
    let periodType;
    if (period && typeof period === "object") {
      const p = period;
      periodType = typeof p.type === "string" ? p.type : undefined;
      if (typeof p.end === "string")
        resetsAt = p.end;
      if (typeof p.start === "string" && typeof p.end === "string") {
        const ms = Date.parse(p.end) - Date.parse(p.start);
        if (Number.isFinite(ms) && ms > 0)
          windowSeconds = Math.round(ms / 1000);
      }
    }
    if (!resetsAt && typeof config.billingPeriodEnd === "string") {
      resetsAt = config.billingPeriodEnd;
    }
    const kind = periodType?.includes("WEEKLY") || windowSeconds != null && windowSeconds >= 6 * 24 * 3600 ? "weekly" : "period";
    const windows = [
      {
        kind,
        usedPercent: used,
        remainingPercent: remaining2(used),
        resetsAt,
        windowSeconds,
        label: "grok",
        limitReached: used != null && (used >= 100 || limitReached)
      }
    ];
    const productUsage = config.productUsage;
    if (Array.isArray(productUsage)) {
      for (const row of productUsage) {
        if (!row || typeof row !== "object")
          continue;
        const r = row;
        const product = typeof r.product === "string" ? r.product : "product";
        const pu = typeof r.usagePercent === "number" ? r.usagePercent : null;
        if (product.toLowerCase() === "grokbuild" && pu === used)
          continue;
        windows.push({
          kind: "other",
          usedPercent: pu,
          remainingPercent: remaining2(pu),
          resetsAt,
          label: product,
          limitReached: pu != null && pu >= 100
        });
      }
    }
    return {
      provider,
      profile,
      source: "grok-billing",
      fetchedAt,
      ok: true,
      windows,
      extras: {
        periodType,
        prepaidBalance,
        isUnifiedBillingUser,
        onDemandCap,
        onDemandUsed,
        unreported,
        entitlementExhausted
      }
    };
  } catch (error) {
    return {
      provider,
      profile,
      source: "grok-billing",
      fetchedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      windows: []
    };
  }
}

// src/usage/fetch.ts
function isUnreportedUsage(usage) {
  if (usage.extras?.unreported === true)
    return true;
  const primary = usage.windows.find((w) => w.remainingPercent != null) ?? usage.windows[0];
  return !primary || primary.remainingPercent == null;
}
function applyUsageToAccountState(store, usage) {
  const account = store.getAccount(usage.provider, usage.profile);
  if (!account || !usage.ok)
    return;
  const primary = usage.windows.find((w) => w.remainingPercent != null) ?? usage.windows[0];
  if (isUnreportedUsage(usage) || !primary || primary.remainingPercent == null) {
    if (account.availability === "QUOTA_EXHAUSTED" || account.availability === "AVAILABLE" || account.availability === "ACTIVE" || account.availability === "UNKNOWN") {
      store.upsertAccount({
        ...account,
        availability: "QUOTA_UNKNOWN",
        reason: "remote_usage_unreported",
        until: null,
        lastChecked: usage.fetchedAt
      });
    }
    return;
  }
  if (primary.remainingPercent <= 0 || primary.limitReached) {
    const next = {
      ...account,
      availability: "QUOTA_EXHAUSTED",
      reason: `remote_usage_${primary.label ?? primary.kind}_0`,
      lastChecked: usage.fetchedAt,
      until: primary.resetsAt ?? null
    };
    store.upsertAccount(next);
  } else if (account.availability === "QUOTA_EXHAUSTED" && primary.remainingPercent > 5) {
    store.upsertAccount({
      ...account,
      availability: "AVAILABLE",
      reason: undefined,
      until: null,
      lastChecked: usage.fetchedAt
    });
  } else if (account.availability === "QUOTA_UNKNOWN" && primary.remainingPercent > 0 && !primary.limitReached) {
    store.upsertAccount({
      ...account,
      availability: "AVAILABLE",
      reason: undefined,
      until: null,
      lastChecked: usage.fetchedAt
    });
  }
}
function attachUsageHttpDiagnostics(usage) {
  if (usage.ok || !usage.error)
    return usage;
  const match = /\bHTTP (\d+)\b/.exec(usage.error);
  if (!match)
    return usage;
  const httpStatus = Number(match[1]);
  if (!Number.isFinite(httpStatus))
    return usage;
  const extras = { ...usage.extras, httpStatus };
  if (httpStatus === 401 && usage.source === "codex-wham") {
    extras.diagnostic = "chatgpt-wham-unauthorized";
  }
  return { ...usage, extras };
}
async function fetchRemoteUsage(store, provider, profile, opts) {
  const root = opts?.root ?? store.rootDir ?? defaultOarRoot();
  const maxAgeMs = opts?.maxAgeMs ?? 60000;
  if (!opts?.force) {
    const cached = getCachedUsage(provider, profile, { maxAgeMs, root });
    if (cached)
      return cached;
  }
  const cred = store.getVaultCredential(provider, profile);
  if (!cred) {
    const miss = {
      provider,
      profile,
      source: "none",
      fetchedAt: new Date().toISOString(),
      ok: false,
      error: "missing vault credential",
      windows: []
    };
    if (opts?.persistCache !== false) {
      putCachedUsage(miss, root);
    }
    return miss;
  }
  let result;
  if (resolveProvider(provider) === "chatgpt-subscription") {
    result = await fetchCodexUsage(provider, profile, cred, { fetchImpl: opts?.fetchImpl });
    result = attachUsageHttpDiagnostics(result);
  } else if (resolveProvider(provider) === "xai") {
    result = await fetchXaiGrokSubscriptionUsage(provider, profile, cred, {
      fetchImpl: opts?.fetchImpl
    });
    result = attachUsageHttpDiagnostics(result);
  } else {
    result = {
      provider,
      profile,
      source: "unsupported",
      fetchedAt: new Date().toISOString(),
      ok: false,
      error: `no remote usage adapter for ${provider}`,
      windows: []
    };
  }
  if (opts?.persistCache !== false) {
    putCachedUsage(result, root);
  }
  if (opts?.applyState !== false) {
    applyUsageToAccountState(store, result);
  }
  return result;
}
async function fetchRemoteUsageForAccounts(store, accounts, opts) {
  const out = [];
  const queue = [...accounts];
  const workers = Math.min(3, queue.length || 1);
  async function worker() {
    while (queue.length) {
      if (opts?.shouldContinue && !opts.shouldContinue())
        return;
      const next = queue.shift();
      if (!next)
        return;
      out.push(await fetchRemoteUsage(store, next.provider, next.profile, opts));
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

// src/xai-login.ts
var XAI_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";
async function loginFromXaiUserinfo(cred, opts) {
  if (!cred || cred.type !== "oauth")
    return;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;
  try {
    const response = await fetchImpl(XAI_USERINFO_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cred.access}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok)
      return;
    const parsed = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return;
    return emailFromUnknown(parsed.email);
  } catch {
    return;
  }
}

// src/xai-relogin-heal.ts
function findXaiReloginHealCandidate(store, authPaths, now = Date.now()) {
  const preferred = store.getState().providers.xai?.preferred;
  if (!preferred)
    return;
  const vault = store.getVaultCredential("xai", preferred);
  const vaultSubject = subjectFromCredential(vault);
  if (!vaultSubject)
    return;
  for (const authPath of authPaths) {
    let primary;
    let latest;
    try {
      primary = readCredentialFromAuthJson(authPath, "xai", { account: "primary" });
      latest = readCredentialFromAuthJson(authPath, "xai", { account: "latest" });
    } catch (error) {
      if (error instanceof Error)
        continue;
      throw error;
    }
    if (primary.type !== "oauth" || latest.type !== "oauth")
      continue;
    const primarySubject = subjectFromCredential(primary);
    const latestSubject = subjectFromCredential(latest);
    if (!primarySubject || primarySubject !== latestSubject || latestSubject !== vaultSubject || latest.expires <= primary.expires || latest.expires <= now + 5 * 60 * 1000 || latest.refresh === primary.refresh) {
      continue;
    }
    return { authPath, profile: preferred, credential: latest };
  }
  return;
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
  quotaPollIntervalMs;
  server = null;
  quotaPollTimer = null;
  quotaPollInFlight = false;
  running = false;
  lifecycleEpoch = 0;
  now;
  useWallPromotionTimer;
  promotionStore;
  queueStore;
  queueManager;
  queueListeners = new Set;
  promotionTimer = null;
  lastInWindow;
  constructor(opts) {
    this.store = opts.store;
    this.router = new OarRouter(opts.store);
    this.activator = new AuthSlotActivator({
      store: opts.store,
      authPaths: opts.authPaths,
      preferSenpiLock: opts.preferSenpiLock,
      sinks: opts.sinks ?? createDefaultSinks()
    });
    this.socketPath = opts.socketPath;
    this.activateOnUse = opts.activateOnUse ?? true;
    this.events = EventLog.forRoot(opts.store.rootDir);
    this.quotaPollIntervalMs = opts.quotaPollIntervalMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.useWallPromotionTimer = opts.now == null;
    this.promotionStore = new PromotionStore({ rootDir: opts.store.rootDir });
    this.queueStore = new QueueStore({ rootDir: opts.store.rootDir });
    this.queueManager = new QueueManager({
      store: this.queueStore,
      schedule: () => this.promotionStore.get(),
      now: this.now,
      runner: opts.queueRunner ?? createOmoQueueRunner(opts.omoCommand ?? { bin: "omo" }),
      emit: (event) => this.emitQueueEvent(event),
      retryDelayMs: opts.queueRetryDelayMs,
      sleep: opts.queueSleep
    });
  }
  onQueueEvent(handler) {
    this.queueListeners.add(handler);
    return () => {
      this.queueListeners.delete(handler);
    };
  }
  async reconcilePromotion() {
    const schedule = this.promotionStore.get();
    const inWindow = isInPromotionWindow(this.now(), schedule);
    if (this.lastInWindow === true && !inWindow) {
      this.emitQueueEvent({ type: "promotion:exited" });
    } else if (this.lastInWindow === false && inWindow) {
      this.emitQueueEvent({ type: "promotion:entered" });
    } else if (this.lastInWindow === undefined && inWindow) {
      this.emitQueueEvent({ type: "promotion:entered" });
    }
    this.lastInWindow = inWindow;
    await this.queueManager.reconcile();
    this.armPromotionTimer();
  }
  emitQueueEvent(event) {
    this.events.append({
      ts: new Date(this.now()).toISOString(),
      event: event.type,
      reason: "id" in event ? event.id : undefined
    });
    for (const handler of [...this.queueListeners])
      handler(event);
  }
  armPromotionTimer() {
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
    if (!this.useWallPromotionTimer || !this.running)
      return;
    const next = nextWindowBoundary(this.now(), this.promotionStore.get());
    if (!next)
      return;
    const delay = Math.max(0, Math.min(next.at - this.now(), 2147000000));
    this.promotionTimer = setTimeout(() => {
      this.reconcilePromotion();
    }, delay);
    this.promotionTimer.unref();
  }
  get refresh() {
    return this.refreshLock;
  }
  get leaseManager() {
    return this.leases;
  }
  async start() {
    mkdirSync7(dirname8(this.socketPath), { recursive: true, mode: 448 });
    if (existsSync13(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        try {
          chmodSync5(this.socketPath, 384);
        } catch {}
        resolve();
      });
    });
    writeFileSync6(`${this.socketPath}.pid`, String(process.pid), { mode: 384 });
    this.running = true;
    this.lifecycleEpoch += 1;
    this.events.append({ ts: new Date().toISOString(), event: "daemon_start", pid: process.pid });
    this.queueManager.resetLifecycle();
    this.queueManager.markStaleRunning();
    await this.reconcilePromotion();
    if (this.quotaPollIntervalMs > 0) {
      this.runScheduledQuotaPoll();
      this.quotaPollTimer = setInterval(() => {
        this.runScheduledQuotaPoll();
      }, this.quotaPollIntervalMs);
      this.quotaPollTimer.unref();
    }
  }
  async stop() {
    this.running = false;
    this.lifecycleEpoch += 1;
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
    await this.queueManager.shutdown();
    if (this.quotaPollTimer) {
      clearInterval(this.quotaPollTimer);
      this.quotaPollTimer = null;
    }
    await new Promise((resolve) => {
      if (!this.server)
        return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    if (existsSync13(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    const pidPath = `${this.socketPath}.pid`;
    if (existsSync13(pidPath)) {
      try {
        unlinkSync(pidPath);
      } catch {}
    }
    this.events.append({ ts: new Date().toISOString(), event: "daemon_stop", pid: process.pid });
  }
  handleSocket(socket) {
    let buf = Buffer.alloc(0);
    socket.on("data", async (chunk) => {
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
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
  async backfillXaiLogins(provider) {
    if (provider && provider !== "xai")
      return;
    const pending = this.store.listAccounts("xai").filter((account) => !account.login);
    if (pending.length === 0)
      return;
    await Promise.all(pending.map(async (account) => {
      const login = await loginFromXaiUserinfo(this.store.getVaultCredential("xai", account.profile));
      if (!login)
        return;
      const latest = this.store.getAccount("xai", account.profile);
      if (!latest || latest.login)
        return;
      this.store.upsertAccount({ ...latest, login });
    }));
  }
  async healXaiRelogin() {
    const candidate = findXaiReloginHealCandidate(this.store, this.activator.getAuthPaths());
    if (!candidate)
      return false;
    this.store.putVaultCredential("xai", candidate.profile, candidate.credential);
    await this.activator.activate("xai", candidate.profile);
    this.router.use("xai", candidate.profile);
    this.events.append({
      ts: new Date().toISOString(),
      event: "xai_relogin_heal",
      provider: "xai",
      profile: candidate.profile,
      reason: "same_subject_newer_login"
    });
    return true;
  }
  async fetchVerifiedPositiveProfiles(provider, currentProfile, guard = () => true) {
    const targets = this.store.listAccounts(provider).filter((account) => account.profile !== currentProfile).map((account) => ({ provider: account.provider, profile: account.profile }));
    if (!guard())
      return new Set;
    for (const target of targets) {
      const account = this.store.getAccount(target.provider, target.profile);
      if (!account)
        continue;
      this.store.upsertAccount({
        ...account,
        availability: "QUOTA_UNKNOWN",
        reason: "remote_usage_unverified",
        lastChecked: new Date().toISOString()
      });
    }
    const rows = await fetchRemoteUsageForAccounts(this.store, targets, {
      root: this.store.rootDir,
      force: true,
      maxAgeMs: 0,
      applyState: false,
      persistCache: false,
      shouldContinue: guard
    });
    const positive = new Set;
    if (!guard())
      return positive;
    for (const row of rows) {
      if (!row.ok) {
        const account = this.store.getAccount(row.provider, row.profile);
        if (account) {
          this.store.upsertAccount({
            ...account,
            availability: "QUOTA_UNKNOWN",
            reason: "remote_usage_unknown",
            lastChecked: new Date().toISOString()
          });
        }
        continue;
      }
      const primary = row.windows.find((window) => window.remainingPercent != null) ?? row.windows[0];
      if (row.extras?.unreported === true || !primary || primary.remainingPercent == null) {
        const account = this.store.getAccount(row.provider, row.profile);
        if (account) {
          this.store.upsertAccount({
            ...account,
            availability: "QUOTA_UNKNOWN",
            reason: row.extras?.unreported === true ? "remote_usage_unreported" : "remote_usage_unknown",
            lastChecked: new Date().toISOString()
          });
        }
        continue;
      }
      if (primary.remainingPercent > 0 && !primary.limitReached) {
        positive.add(row.profile);
        this.router.reportResult({
          provider: row.provider,
          account: row.profile,
          result: "QUOTA_AVAILABLE",
          detail: `remote_usage_${primary.label ?? primary.kind}_${primary.remainingPercent}`
        });
      } else {
        this.router.reportResult({
          provider: row.provider,
          account: row.profile,
          result: "QUOTA_EXHAUSTED",
          detail: `remote_usage_${primary.label ?? primary.kind}_0`
        });
      }
    }
    return positive;
  }
  selectVerifiedFailover(provider, currentProfile, verifiedPositiveProfiles) {
    return this.store.listAccounts(provider).filter((account) => {
      return account.profile !== currentProfile && verifiedPositiveProfiles.has(account.profile) && isEligible(account);
    }).sort((a, b) => {
      if (a.priority !== b.priority)
        return a.priority - b.priority;
      const aUsed = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
      const bUsed = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
      return aUsed - bUsed || a.profile.localeCompare(b.profile);
    })[0]?.profile;
  }
  pollLifecycleCurrent(epoch) {
    return this.running && this.lifecycleEpoch === epoch;
  }
  pollPolicyCurrent(provider, profile) {
    const policy = this.store.getProviderPolicy(provider);
    return policy.preferred === profile && policy.autoFailover && (policy.mode === "auto" || process.env.OAR_FORCE_AUTO === "1");
  }
  async pollQuota(epoch) {
    const state = this.store.getState();
    const checked = [];
    const failovers = [];
    for (const [provider, policy] of Object.entries(state.providers)) {
      if (!this.pollLifecycleCurrent(epoch))
        return { checked, failovers };
      const autoOn = policy.autoFailover && (policy.mode === "auto" || process.env.OAR_FORCE_AUTO === "1");
      if (!autoOn || !policy.preferred)
        continue;
      const current = this.store.getAccount(provider, policy.preferred);
      if (!current)
        continue;
      const [usage] = await fetchRemoteUsageForAccounts(this.store, [{ provider: current.provider, profile: current.profile }], {
        root: this.store.rootDir,
        force: true,
        maxAgeMs: 0,
        applyState: false,
        persistCache: false
      });
      if (!this.pollLifecycleCurrent(epoch))
        return { checked, failovers };
      if (!this.pollPolicyCurrent(provider, current.profile))
        continue;
      if (!usage?.ok) {
        checked.push({ provider, profile: current.profile, ok: false });
        continue;
      }
      const primary = usage.windows.find((window) => window.remainingPercent != null) ?? usage.windows[0];
      if (usage.extras?.unreported === true || !primary || primary.remainingPercent == null) {
        checked.push({ provider, profile: current.profile, ok: false });
        continue;
      }
      const remainingPercent = primary.remainingPercent;
      checked.push({ provider, profile: current.profile, remainingPercent, ok: true });
      if (remainingPercent !== 0) {
        this.router.reportResult({
          provider,
          account: current.profile,
          result: "QUOTA_AVAILABLE",
          detail: `quota_poll_${remainingPercent}`
        });
        continue;
      }
      this.router.reportResult({
        provider,
        account: current.profile,
        result: "QUOTA_EXHAUSTED",
        detail: "quota_poll_0"
      });
      const guard = () => this.pollLifecycleCurrent(epoch) && this.pollPolicyCurrent(provider, current.profile);
      const positive = await this.fetchVerifiedPositiveProfiles(provider, current.profile, guard);
      if (!this.pollLifecycleCurrent(epoch))
        return { checked, failovers };
      if (!this.pollPolicyCurrent(provider, current.profile))
        continue;
      const nextProfile = this.selectVerifiedFailover(provider, current.profile, positive);
      if (!nextProfile || !this.activateOnUse)
        continue;
      this.router.use(provider, nextProfile);
      await this.activator.activate(provider, nextProfile);
      failovers.push({ provider, from: current.profile, to: nextProfile });
      this.events.append({
        ts: new Date().toISOString(),
        event: "failover",
        provider,
        profile: nextProfile,
        reason: `from ${current.profile} (quota_poll_0)`
      });
    }
    this.events.append({
      ts: new Date().toISOString(),
      event: "quota_poll",
      reason: `checked=${checked.length} failovers=${failovers.length}`
    });
    return { checked, failovers };
  }
  async runQuotaPollOnce() {
    if (this.quotaPollInFlight)
      return;
    this.quotaPollInFlight = true;
    const epoch = this.lifecycleEpoch;
    try {
      return await this.pollQuota(epoch);
    } finally {
      this.quotaPollInFlight = false;
    }
  }
  async runScheduledQuotaPoll() {
    try {
      await this.runQuotaPollOnce();
    } catch (error) {
      this.events.append({
        ts: new Date().toISOString(),
        event: "quota_poll_error",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  async dispatch(req) {
    if (!req || req.protocol !== 1) {
      return { ok: false, error: "unsupported protocol" };
    }
    if ("provider" in req && typeof req.provider === "string") {
      req = { ...req, provider: resolveProvider(req.provider) };
    }
    switch (req.action) {
      case "ping":
        return { ok: true, data: { pong: true, pid: process.pid } };
      case "resolve": {
        const resolved = this.router.resolve(req);
        if (this.activateOnUse && resolved.status === "available" && resolved.profile) {
          try {
            await this.activator.ensureActivated(req.provider, resolved.profile);
          } catch {}
        }
        return { ok: true, data: resolved };
      }
      case "use": {
        try {
          const resolved = this.router.use(req.provider, req.profile, { force: Boolean(req.force) });
          this.events.append({
            ts: new Date().toISOString(),
            event: "use",
            provider: req.provider,
            profile: req.profile,
            reason: req.force ? "manual-force" : "manual",
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
                sinks: act.sinks,
                message: resolved.availability === "QUOTA_UNKNOWN" ? `${req.provider} ${req.profile} is now preferred for manual use. ` + "Remote quota is unreported; auto routing will wait for verified usage." : `${req.provider} ${req.profile} is now preferred. ` + "Running OMO sessions will use it on their next eligible request."
              }
            };
          }
          return { ok: true, data: resolved };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { ok: false, error: msg };
        }
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
      case "order": {
        const accounts = this.store.listAccounts(req.provider);
        if (accounts.length === 0) {
          return { ok: false, error: `no accounts for ${req.provider}` };
        }
        if (req.profiles) {
          const unique = new Set(req.profiles);
          const known = new Set(accounts.map((account) => account.profile));
          if (unique.size !== req.profiles.length || req.profiles.length !== accounts.length || req.profiles.some((profile) => !known.has(profile))) {
            return {
              ok: false,
              error: `order must list every ${req.provider} profile exactly once ` + `(available: ${[...known].join(", ")})`
            };
          }
          req.profiles.forEach((profile, index) => {
            const account = this.store.getAccount(req.provider, profile);
            if (!account)
              return;
            this.store.upsertAccount({ ...account, priority: (index + 1) * 100 });
          });
          this.events.append({
            ts: new Date().toISOString(),
            event: "order",
            provider: req.provider,
            reason: req.profiles.join(",")
          });
        }
        const ordered = this.store.listAccounts(req.provider).sort((a, b) => a.priority - b.priority || a.profile.localeCompare(b.profile)).map((account) => ({ profile: account.profile, priority: account.priority }));
        return { ok: true, data: { provider: req.provider, profiles: ordered } };
      }
      case "mode":
        this.router.setMode(req.provider, req.mode);
        return { ok: true, data: { provider: req.provider, mode: req.mode } };
      case "report": {
        let parsedResult;
        try {
          parsedResult = parseReportResult(String(req.result));
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
        const existing = this.store.getAccount(req.provider, req.account);
        if (!existing) {
          return {
            ok: false,
            error: `unknown account ${req.provider}/${req.account}`
          };
        }
        const updated = this.router.reportResult({
          provider: req.provider,
          account: req.account,
          result: parsedResult,
          retryAfterSec: req.retryAfterSec,
          detail: req.detail
        });
        if (!updated) {
          return {
            ok: false,
            error: `unknown account ${req.provider}/${req.account}`
          };
        }
        this.events.append({
          ts: new Date().toISOString(),
          event: "report",
          provider: req.provider,
          profile: req.account,
          reason: String(req.result)
        });
        const policy = this.store.getProviderPolicy(req.provider);
        const failoverResults = new Set([
          "AUTH_REVOKED",
          "AUTH_EXPIRED",
          "RATE_LIMITED",
          "QUOTA_EXHAUSTED"
        ]);
        const autoOn = policy.autoFailover && (policy.mode === "auto" || process.env.OAR_FORCE_AUTO === "1");
        let failover;
        if (this.activateOnUse && autoOn && policy.preferred === req.account && typeof req.result === "string" && failoverResults.has(req.result)) {
          let nextProfile;
          if (req.result === "QUOTA_EXHAUSTED") {
            nextProfile = this.selectVerifiedFailover(req.provider, req.account, req.verifiedPositiveProfiles ? new Set(req.verifiedPositiveProfiles) : await this.fetchVerifiedPositiveProfiles(req.provider, req.account));
          } else {
            const next = this.router.resolve({ provider: req.provider });
            nextProfile = next.status === "available" ? next.profile : undefined;
          }
          if (nextProfile && nextProfile !== req.account) {
            try {
              this.router.use(req.provider, nextProfile);
              await this.activator.activate(req.provider, nextProfile);
              failover = { from: req.account, to: nextProfile };
              this.events.append({
                ts: new Date().toISOString(),
                event: "failover",
                provider: req.provider,
                profile: nextProfile,
                reason: `from ${req.account} (${String(req.result)})`
              });
            } catch {}
          }
        }
        return { ok: true, data: { account: updated, failover } };
      }
      case "status": {
        this.store.backfillAccountLogins();
        await this.backfillXaiLogins();
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
      case "accounts": {
        this.store.backfillAccountLogins(req.provider);
        await this.backfillXaiLogins(req.provider);
        return { ok: true, data: this.store.listAccounts(req.provider) };
      }
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
        const existing = this.store.getAccount(req.provider, req.profile);
        if (!existing) {
          return {
            ok: false,
            error: `unknown account ${req.provider}/${req.profile}`
          };
        }
        const credential = this.store.getVaultCredential(req.provider, req.profile);
        let authSlots = [];
        if (credential) {
          try {
            authSlots = this.activator.clearMatchingSlots(req.provider, credential);
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
        try {
          this.store.removeAccount(req.provider, req.profile);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
        this.leases.releaseAccount(req.provider, req.profile);
        this.events.append({
          ts: new Date().toISOString(),
          event: "remove",
          provider: req.provider,
          profile: req.profile
        });
        return {
          ok: true,
          data: {
            provider: req.provider,
            profile: req.profile,
            authSlotsCleared: authSlots.filter((slot) => slot.result === "cleared").map((slot) => slot.path),
            authSlotsKept: authSlots.filter((slot) => slot.result === "kept").map((slot) => slot.path)
          }
        };
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
        await this.backfillXaiLogins(req.provider);
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
            if (this.activateOnUse && req.activate !== false) {
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
      case "bootstrap-auto": {
        await this.healXaiRelogin();
        const state = this.store.getState();
        const byProvider = new Map;
        for (const a of state.accounts) {
          const list = byProvider.get(a.provider) ?? [];
          list.push(a);
          byProvider.set(a.provider, list);
        }
        const enabled = [];
        for (const [provider, accounts] of byProvider) {
          if (accounts.length < 2)
            continue;
          this.store.setProviderMode(provider, "auto");
          this.store.setAutoFailover(provider, true);
          const preferred = this.store.getProviderPolicy(provider).preferred ?? [...accounts].sort((a, b) => a.priority - b.priority)[0]?.profile;
          if (preferred && this.activateOnUse) {
            try {
              await this.activator.ensureActivated(provider, preferred);
              this.router.use(provider, preferred);
            } catch {}
          }
          enabled.push({ provider, profiles: accounts.length, preferred });
          this.events.append({
            ts: new Date().toISOString(),
            event: "bootstrap-auto",
            provider,
            reason: `profiles=${accounts.length}`
          });
        }
        return { ok: true, data: { enabled, forceAuto: process.env.OAR_FORCE_AUTO === "1" } };
      }
      case "poll-quota":
        return {
          ok: true,
          data: await this.runQuotaPollOnce() ?? { checked: [], failovers: [], skipped: "in_flight" }
        };
      case "doctor":
        return {
          ok: true,
          data: {
            socketPath: this.socketPath,
            rootDir: this.store.rootDir,
            authPaths: this.activator.getAuthPaths(),
            accountCount: this.store.listAccounts().length,
            leaseCount: this.leases.list().length,
            quotaPollIntervalMs: this.quotaPollIntervalMs,
            pid: process.pid,
            promotion: promotionStatusView(this.promotionStore.get(), this.now())
          }
        };
      case "schedule-configure": {
        const current = this.promotionStore.get();
        try {
          const next = normalizePromotionSchedule({
            ...current,
            enabled: true,
            ...req.timezone != null ? { timezone: req.timezone } : {},
            ...req.start != null ? { start: req.start } : {},
            ...req.end != null ? { end: req.end } : {},
            ...req.provider != null ? { provider: req.provider } : {},
            ...req.model != null ? { model: req.model } : {},
            ...req.maxConcurrency != null ? { maxConcurrency: req.maxConcurrency } : {},
            ...req.maxAttempts != null ? { maxAttempts: req.maxAttempts } : {}
          });
          const saved = this.promotionStore.set(next);
          this.events.append({
            ts: new Date(this.now()).toISOString(),
            event: "schedule-configure",
            reason: `${saved.timezone} ${saved.start}-${saved.end} ${saved.provider}/${saved.model}`
          });
          await this.reconcilePromotion();
          return { ok: true, data: promotionStatusView(saved, this.now()) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "schedule-status":
        return { ok: true, data: promotionStatusView(this.promotionStore.get(), this.now()) };
      case "schedule-off": {
        const saved = this.promotionStore.set({ ...this.promotionStore.get(), enabled: false });
        this.events.append({
          ts: new Date(this.now()).toISOString(),
          event: "schedule-off"
        });
        await this.reconcilePromotion();
        return { ok: true, data: promotionStatusView(saved, this.now()) };
      }
      case "queue-add": {
        try {
          const task = this.queueStore.add({
            prompt: req.prompt,
            repository: req.repository,
            isolation: req.isolation,
            maxAttempts: req.maxAttempts ?? this.promotionStore.get().maxAttempts,
            dependsOn: req.dependsOn,
            nowMs: this.now()
          });
          this.events.append({
            ts: new Date(this.now()).toISOString(),
            event: "queue-add",
            reason: task.id
          });
          await this.reconcilePromotion();
          const latest = this.queueStore.get(task.id) ?? task;
          return { ok: true, data: annotateQueueTask(latest, this.queueStore.list()) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "queue-list":
        return { ok: true, data: annotateQueueTasks(this.queueStore.list()) };
      case "queue-cancel": {
        try {
          const task = await this.queueManager.cancel(req.id);
          this.events.append({
            ts: new Date(this.now()).toISOString(),
            event: "queue-cancel",
            reason: req.id
          });
          return { ok: true, data: task };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "queue-retry": {
        try {
          const task = await this.queueManager.retry(req.id);
          this.events.append({
            ts: new Date(this.now()).toISOString(),
            event: "queue-retry",
            reason: req.id
          });
          return { ok: true, data: task };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      default:
        return { ok: false, error: `unknown action` };
    }
  }
}

// src/paths.ts
import { existsSync as existsSync14 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join9 } from "node:path";
function defaultOarRoot2(env = process.env) {
  if (env.OAR_HOME)
    return env.OAR_HOME;
  return join9(homedir4(), ".oar");
}
function oarSocketPath(root = defaultOarRoot2()) {
  return join9(root, "oar.sock");
}
function unique2(paths) {
  const out = [];
  for (const p of paths) {
    if (!out.includes(p))
      out.push(p);
  }
  return out;
}
function resolveActiveAuthPaths2(env = process.env, home = homedir4()) {
  if (env.OAR_AUTH_PATH)
    return unique2([env.OAR_AUTH_PATH]);
  const envDirs = [
    env.OAR_AUTH_DIR,
    env.OMO_CODING_AGENT_DIR,
    env.SENPI_CODING_AGENT_DIR,
    env.PI_CODING_AGENT_DIR
  ].filter((v) => typeof v === "string" && v.length > 0);
  const known = knownAuthJsonCandidates2(home);
  const existing = known.filter((p) => existsSync14(p));
  const selected = envDirs.length > 0 ? envDirs.map((dir) => join9(dir, "auth.json")) : [];
  const targets = unique2([...selected, ...existing]);
  if (targets.length > 0)
    return targets;
  return [join9(home, ".omo", "agent", "auth.json")];
}
function knownAuthJsonCandidates2(home) {
  return unique2([
    join9(home, ".omo", "agent", "auth.json"),
    join9(home, ".omo", "auth.json"),
    join9(home, ".senpi", "agent", "auth.json"),
    join9(home, ".senpi", "remote-agent", "auth.json")
  ]);
}

// src/store.ts
import {
  chmodSync as chmodSync6,
  existsSync as existsSync15,
  mkdirSync as mkdirSync8,
  readFileSync as readFileSync9,
  renameSync as renameSync5,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync7
} from "node:fs";
import { dirname as dirname9, join as join10 } from "node:path";
var DEFAULT_POLICY = {
  mode: "manual",
  autoFailover: false
};
function emptyState() {
  return { version: 1, providers: {}, accounts: [], updatedAt: new Date().toISOString() };
}
function atomicWriteJson3(path, data, mode = 384) {
  mkdirSync8(dirname9(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync7(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync5(tmp, path);
  try {
    chmodSync6(path, mode);
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
    mkdirSync8(this.rootDir, { recursive: true, mode: 448 });
    mkdirSync8(this.vaultDir, { recursive: true, mode: 448 });
    this.state = this.load();
    if (this.migrateLegacyProviders())
      this.persist();
  }
  migrateLegacyProviders() {
    let changed = false;
    const accounts = this.state.accounts.map((account) => {
      const provider = resolveProvider(account.provider);
      if (provider === account.provider)
        return account;
      changed = true;
      this.renameVaultFile(account.provider, provider, account.profile);
      return { ...account, provider, credentialRef: `vault:${provider}:${account.profile}` };
    });
    const providers = {};
    for (const [key, policy] of Object.entries(this.state.providers)) {
      const provider = resolveProvider(key);
      if (provider !== key)
        changed = true;
      providers[provider] = { ...providers[provider] ?? {}, ...policy };
    }
    if (!changed)
      return false;
    this.state = { ...this.state, accounts, providers };
    return true;
  }
  renameVaultFile(from, to, profile) {
    const oldPath = join10(this.vaultDir, `${from}__${profile}.json`);
    const nextPath = join10(this.vaultDir, `${to}__${profile}.json`);
    if (existsSync15(oldPath) && !existsSync15(nextPath))
      renameSync5(oldPath, nextPath);
  }
  load() {
    if (!existsSync15(this.statePath))
      return emptyState();
    try {
      const parsed = JSON.parse(readFileSync9(this.statePath, "utf8"));
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
    atomicWriteJson3(this.statePath, this.state, 384);
  }
  getState() {
    return structuredClone(this.state);
  }
  listAccounts(provider) {
    if (!provider)
      return this.state.accounts;
    const canonical = resolveProvider(provider);
    return this.state.accounts.filter((a) => resolveProvider(a.provider) === canonical);
  }
  getAccount(provider, profile) {
    const canonical = resolveProvider(provider);
    return this.state.accounts.find((a) => resolveProvider(a.provider) === canonical && a.profile === profile);
  }
  upsertAccount(account) {
    const provider = resolveProvider(account.provider);
    const next = provider === account.provider ? account : { ...account, provider, credentialRef: `vault:${provider}:${account.profile}` };
    const idx = this.state.accounts.findIndex((a) => resolveProvider(a.provider) === provider && a.profile === next.profile);
    account = next;
    if (idx >= 0)
      this.state.accounts[idx] = account;
    else
      this.state.accounts.push(account);
    this.persist();
  }
  removeAccount(provider, profile) {
    const canonical = resolveProvider(provider);
    const vaultPath = this.vaultPath(canonical, profile);
    const legacyPath = join10(this.vaultDir, `${provider}__${profile}.json`);
    if (existsSync15(vaultPath)) {
      unlinkSync2(vaultPath);
    }
    if (legacyPath !== vaultPath && existsSync15(legacyPath))
      unlinkSync2(legacyPath);
    this.state.accounts = this.state.accounts.filter((a) => !(resolveProvider(a.provider) === canonical && a.profile === profile));
    const policy = this.state.providers[canonical] ?? this.state.providers[provider];
    if (policy?.preferred === profile) {
      const next = { ...policy };
      delete next.preferred;
      delete this.state.providers[provider];
      this.state.providers[canonical] = next;
    }
    this.persist();
  }
  getProviderPolicy(provider) {
    const canonical = resolveProvider(provider);
    return { ...DEFAULT_POLICY, ...this.state.providers[canonical] ?? this.state.providers[provider] ?? {} };
  }
  setProviderMode(provider, mode) {
    const canonical = resolveProvider(provider);
    const cur = this.getProviderPolicy(canonical);
    this.state.providers[canonical] = { ...cur, mode };
    this.persist();
  }
  setAutoFailover(provider, enabled) {
    const canonical = resolveProvider(provider);
    const cur = this.getProviderPolicy(canonical);
    this.state.providers[canonical] = { ...cur, autoFailover: enabled };
    this.persist();
  }
  setPreferred(provider, profile) {
    const canonical = resolveProvider(provider);
    const cur = this.getProviderPolicy(canonical);
    this.state.providers[canonical] = { ...cur, preferred: profile };
    this.persist();
  }
  vaultPath(provider, profile) {
    return join10(this.vaultDir, `${resolveProvider(provider)}__${profile}.json`);
  }
  putVaultCredential(provider, profile, credential) {
    atomicWriteJson3(this.vaultPath(provider, profile), credential, 384);
    const ref = `vault:${provider}:${profile}`;
    const existing = this.getAccount(provider, profile);
    if (existing) {
      const login = loginFromCredential(credential);
      this.upsertAccount({
        ...existing,
        credentialRef: ref,
        auth: "valid",
        lastChecked: new Date().toISOString(),
        ...login ? { login } : {}
      });
    }
  }
  backfillAccountLogins(provider) {
    let changed = false;
    for (const account of this.listAccounts(provider)) {
      if (account.login)
        continue;
      const login = loginFromCredential(this.getVaultCredential(account.provider, account.profile));
      if (!login)
        continue;
      const idx = this.state.accounts.findIndex((a) => a.provider === account.provider && a.profile === account.profile);
      if (idx < 0)
        continue;
      this.state.accounts[idx] = { ...account, login };
      changed = true;
    }
    if (changed)
      this.persist();
    return this.listAccounts(provider);
  }
  getVaultCredential(provider, profile) {
    const path = this.vaultPath(provider, profile);
    if (!existsSync15(path))
      return;
    try {
      return JSON.parse(readFileSync9(path, "utf8"));
    } catch {
      return;
    }
  }
}

// src/daemon-main.ts
var root = process.env.OAR_HOME ?? defaultOarRoot2();
var socketPath = process.env.OAR_SOCK ?? oarSocketPath(root);
var store = new OarStore({ rootDir: root });
var quotaPollSeconds = Number(process.env.OAR_QUOTA_POLL_SEC ?? "60");
if (!Number.isFinite(quotaPollSeconds) || quotaPollSeconds < 0) {
  throw new Error("OAR_QUOTA_POLL_SEC must be a non-negative number");
}
var omoBin = process.env.OAR_OMO_BIN ?? "omo";
var daemon = new OarDaemon({
  store,
  socketPath,
  authPaths: resolveActiveAuthPaths2(),
  activateOnUse: true,
  quotaPollIntervalMs: quotaPollSeconds * 1000,
  omoCommand: { bin: omoBin }
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
