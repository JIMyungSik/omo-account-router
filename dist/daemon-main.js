#!/usr/bin/env node
// @bun

// src/daemon.ts
import { chmodSync as chmodSync4, existsSync as existsSync9, mkdirSync as mkdirSync5, unlinkSync, writeFileSync as writeFileSync4 } from "node:fs";
import { createServer } from "node:net";
import { dirname as dirname6 } from "node:path";

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
      const act2 = await this.activate(provider, profile);
      return { ...act2, via: `${act2.via}+vault-pull-up`, skipped: false };
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
        availability: "ACTIVE"
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
  if ((a.availability === "COOLDOWN" || a.availability === "RATE_LIMITED") && a.until) {
    if (Date.parse(a.until) > now)
      return false;
  } else if (a.availability === "COOLDOWN" || a.availability === "RATE_LIMITED" || a.availability === "AUTH_EXPIRED") {
    return false;
  }
  return ELIGIBLE.includes(a.availability) || a.availability === "UNKNOWN";
}
function refuseReason(account) {
  if (account.availability === "QUOTA_EXHAUSTED") {
    return `quota exhausted (0% / limit)${account.until ? `; resets ~ ${account.until}` : ""}`;
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
    if (!opts?.force && !isEligible(account)) {
      throw new Error(`REFUSED: ${provider}/${profile} is not usable — ${refuseReason(account)}. ` + `Not switching (even if auto is on). Pass force to override.`);
    }
    this.store.setPreferred(provider, profile);
    this.store.upsertAccount({
      ...account,
      lastUsedAt: new Date().toISOString()
    });
    if (opts?.force) {
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
      const next2 = {
        ...account,
        auth: "valid",
        availability: "AVAILABLE",
        reason: undefined,
        until: null,
        lastChecked: new Date().toISOString()
      };
      this.store.upsertAccount(next2);
      return next2;
    }
    if (req.result === "SUCCESS") {
      if (account.availability === "QUOTA_EXHAUSTED") {
        const kept = {
          ...account,
          lastChecked: new Date().toISOString(),
          lastUsedAt: new Date().toISOString()
        };
        this.store.upsertAccount(kept);
        return kept;
      }
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

// src/usage/cache.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync4, readFileSync as readFileSync5, renameSync as renameSync3, writeFileSync as writeFileSync3, chmodSync as chmodSync3 } from "node:fs";
import { dirname as dirname5, join as join5 } from "node:path";
function usageCachePath(root = defaultOarRoot()) {
  return join5(root, "usage-cache.json");
}
function cacheKey(provider, profile) {
  return `${provider}/${profile}`;
}
function loadUsageCache(root = defaultOarRoot()) {
  const path = usageCachePath(root);
  if (!existsSync8(path))
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: {} };
  try {
    const parsed = JSON.parse(readFileSync5(path, "utf8"));
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
  mkdirSync4(dirname5(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: cache.entries
  };
  writeFileSync3(tmp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 384 });
  renameSync3(tmp, path);
  try {
    chmodSync3(path, 384);
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
  if (credential.accountId) {
    headers["ChatGPT-Account-Id"] = credential.accountId;
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(WHAM_USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
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
        windows: []
      };
    }
    if (!response.ok) {
      return {
        provider,
        profile,
        source: "codex-wham",
        fetchedAt,
        ok: false,
        error: `HTTP ${response.status}`,
        windows: []
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
function remaining2(used) {
  if (used == null || !Number.isFinite(used))
    return null;
  return Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10));
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
        windows: []
      };
    }
    if (!response.ok) {
      return {
        provider,
        profile,
        source: "grok-billing",
        fetchedAt,
        ok: false,
        error: `HTTP ${response.status}`,
        windows: []
      };
    }
    const config = data.config && typeof data.config === "object" ? data.config : data;
    const usedRaw = config.creditUsagePercent;
    const used = typeof usedRaw === "number" && Number.isFinite(usedRaw) ? usedRaw : null;
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
        limitReached: used != null && used >= 100
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
        prepaidBalance: config.prepaidBalance?.val
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
function applyUsageToAccountState(store, usage) {
  const account = store.getAccount(usage.provider, usage.profile);
  if (!account || !usage.ok)
    return;
  const primary = usage.windows.find((w) => w.remainingPercent != null) ?? usage.windows[0];
  if (!primary || primary.remainingPercent == null)
    return;
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
  }
}
async function fetchRemoteUsage(store, provider, profile, opts) {
  const root = opts?.root ?? store.rootDir ?? defaultOarRoot();
  const maxAgeMs = opts?.maxAgeMs ?? 60000;
  if (!opts?.force) {
    const cached2 = getCachedUsage(provider, profile, { maxAgeMs, root });
    if (cached2)
      return cached2;
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
    putCachedUsage(miss, root);
    return miss;
  }
  let result;
  if (resolveProvider(provider) === "chatgpt-subscription") {
    result = await fetchCodexUsage(provider, profile, cred, { fetchImpl: opts?.fetchImpl });
  } else if (resolveProvider(provider) === "xai") {
    result = await fetchXaiGrokSubscriptionUsage(provider, profile, cred, {
      fetchImpl: opts?.fetchImpl
    });
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
  putCachedUsage(result, root);
  applyUsageToAccountState(store, result);
  return result;
}
async function fetchRemoteUsageForAccounts(store, accounts, opts) {
  const out = [];
  const queue = [...accounts];
  const workers = Math.min(3, queue.length || 1);
  async function worker() {
    while (queue.length) {
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

// src/import-all.ts
import { readFileSync as readFileSync6 } from "node:fs";
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStoredCredential(value) {
  if (!isRecord3(value))
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
    raw = readFileSync6(authPath, "utf8");
  } catch {
    throw new Error(`unable to read ${authPath}`);
  }
  try {
    const data = JSON.parse(raw);
    if (!isRecord3(data))
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
  if (isRecord3(auth)) {
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
  if (!isRecord3(data))
    return;
  const tokens = data.tokens;
  if (!isRecord3(tokens))
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
    if (!isRecord3(item) || typeof item.name !== "string")
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
  if (!isRecord3(entry) || parent.type !== "oauth" || typeof entry.access !== "string") {
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
    return isRecord3(a) && a["name"] === selected;
  });
  if (idx < 0 || idx >= linked.length) {
    const names = linked.map((a, i) => isRecord3(a) && typeof a["name"] === "string" ? `${i + 1}=${a["name"]}` : `${i + 1}`).join(", ");
    throw new Error(`--account ${account} not found in ${provider} accounts[] (available: ${names})`);
  }
  return credentialFromSlotEntry(slot, linked[idx]);
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
  server = null;
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
  }
  get refresh() {
    return this.refreshLock;
  }
  get leaseManager() {
    return this.leases;
  }
  async start() {
    mkdirSync5(dirname6(this.socketPath), { recursive: true, mode: 448 });
    if (existsSync9(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        try {
          chmodSync4(this.socketPath, 384);
        } catch {}
        resolve();
      });
    });
    writeFileSync4(`${this.socketPath}.pid`, String(process.pid), { mode: 384 });
    this.events.append({ ts: new Date().toISOString(), event: "daemon_start", pid: process.pid });
  }
  async stop() {
    await new Promise((resolve) => {
      if (!this.server)
        return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    if (existsSync9(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    const pidPath = `${this.socketPath}.pid`;
    if (existsSync9(pidPath)) {
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
  async fetchVerifiedPositiveProfiles(provider, currentProfile) {
    const targets = this.store.listAccounts(provider).filter((account) => account.profile !== currentProfile).map((account) => ({ provider: account.provider, profile: account.profile }));
    const rows = await fetchRemoteUsageForAccounts(this.store, targets, {
      root: this.store.rootDir,
      force: true,
      maxAgeMs: 0
    });
    const positive = new Set;
    for (const row of rows) {
      if (!row.ok)
        continue;
      const primary = row.windows.find((window) => window.remainingPercent != null) ?? row.windows[0];
      if (!primary || primary.remainingPercent == null)
        continue;
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
                message: `${req.provider} ${req.profile} is now preferred. Running OMO sessions will use it on their next eligible request.`
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
          const unique2 = new Set(req.profiles);
          const known = new Set(accounts.map((account) => account.profile));
          if (unique2.size !== req.profiles.length || req.profiles.length !== accounts.length || req.profiles.some((profile) => !known.has(profile))) {
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
import { existsSync as existsSync10 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join6 } from "node:path";
function defaultOarRoot2(env = process.env) {
  if (env.OAR_HOME)
    return env.OAR_HOME;
  return join6(homedir4(), ".oar");
}
function oarSocketPath(root = defaultOarRoot2()) {
  return join6(root, "oar.sock");
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
  const existing = known.filter((p) => existsSync10(p));
  const selected = envDirs.length > 0 ? envDirs.map((dir) => join6(dir, "auth.json")) : [];
  const targets = unique2([...selected, ...existing]);
  if (targets.length > 0)
    return targets;
  return [join6(home, ".omo", "agent", "auth.json")];
}
function knownAuthJsonCandidates2(home) {
  return unique2([
    join6(home, ".omo", "agent", "auth.json"),
    join6(home, ".omo", "auth.json"),
    join6(home, ".senpi", "agent", "auth.json"),
    join6(home, ".senpi", "remote-agent", "auth.json")
  ]);
}

// src/store.ts
import {
  chmodSync as chmodSync5,
  existsSync as existsSync11,
  mkdirSync as mkdirSync6,
  readFileSync as readFileSync7,
  renameSync as renameSync4,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync5
} from "node:fs";
import { dirname as dirname7, join as join7 } from "node:path";
var DEFAULT_POLICY = {
  mode: "manual",
  autoFailover: false
};
function emptyState() {
  return { version: 1, providers: {}, accounts: [], updatedAt: new Date().toISOString() };
}
function atomicWriteJson2(path, data, mode = 384) {
  mkdirSync6(dirname7(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync5(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync4(tmp, path);
  try {
    chmodSync5(path, mode);
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
    mkdirSync6(this.rootDir, { recursive: true, mode: 448 });
    mkdirSync6(this.vaultDir, { recursive: true, mode: 448 });
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
    const oldPath = join7(this.vaultDir, `${from}__${profile}.json`);
    const nextPath = join7(this.vaultDir, `${to}__${profile}.json`);
    if (existsSync11(oldPath) && !existsSync11(nextPath))
      renameSync4(oldPath, nextPath);
  }
  load() {
    if (!existsSync11(this.statePath))
      return emptyState();
    try {
      const parsed = JSON.parse(readFileSync7(this.statePath, "utf8"));
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
    atomicWriteJson2(this.statePath, this.state, 384);
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
    const legacyPath = join7(this.vaultDir, `${provider}__${profile}.json`);
    if (existsSync11(vaultPath)) {
      unlinkSync2(vaultPath);
    }
    if (legacyPath !== vaultPath && existsSync11(legacyPath))
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
    return join7(this.vaultDir, `${resolveProvider(provider)}__${profile}.json`);
  }
  putVaultCredential(provider, profile, credential) {
    atomicWriteJson2(this.vaultPath(provider, profile), credential, 384);
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
    if (!existsSync11(path))
      return;
    try {
      return JSON.parse(readFileSync7(path, "utf8"));
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
