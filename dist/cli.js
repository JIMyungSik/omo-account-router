#!/usr/bin/env node
// @bun

// src/cli.ts
import { spawn, spawnSync } from "child_process";
import { existsSync as existsSync9, readFileSync as readFileSync9 } from "fs";
import { homedir as homedir4 } from "os";
import { dirname as dirname5, join as join8 } from "path";
import { fileURLToPath } from "url";

// src/auth-stale.ts
var STALE_CHECK_MS = 7 * 24 * 60 * 60 * 1000;
function applyAuthStaleHints(rows, store) {
  const now = Date.now();
  return rows.map((row) => {
    if (row.auth !== "valid")
      return row;
    const cred = store.getVaultCredential(row.provider, row.profile);
    const hints = [];
    if (cred?.type === "oauth" && cred.expires <= now) {
      hints.push("AUTH may be stale (access token expired)");
    } else if (row.lastChecked) {
      const checked = Date.parse(row.lastChecked);
      if (Number.isFinite(checked) && now - checked > STALE_CHECK_MS) {
        hints.push("AUTH not re-checked recently");
      }
    }
    if (hints.length === 0)
      return row;
    const hint = `${hints.join("; ")} · oar test ${row.provider} ${row.profile} --live`;
    const note = row.note ? `${row.note} · ${hint}` : hint;
    return { ...row, note };
  });
}

// src/client.ts
import { createConnection } from "node:net";

// src/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function defaultOarRoot(env = process.env) {
  if (env.OAR_HOME)
    return env.OAR_HOME;
  return join(homedir(), ".oar");
}
function oarSocketPath(root = defaultOarRoot()) {
  return join(root, "oar.sock");
}
function oarStatePath(root = defaultOarRoot()) {
  return join(root, "state.json");
}
function oarVaultDir(root = defaultOarRoot()) {
  return join(root, "vault");
}
function oarEventsPath(root = defaultOarRoot()) {
  return join(root, "events.jsonl");
}

// src/client.ts
function isRetryable(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("ENOENT") || msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET") || msg.includes("EPIPE") || msg.includes("OAR daemon timeout");
}

class OarClient {
  socketPath;
  timeoutMs;
  retries;
  constructor(opts) {
    this.socketPath = opts?.socketPath ?? oarSocketPath();
    this.timeoutMs = opts?.timeoutMs ?? 5000;
    this.retries = opts?.retries ?? 0;
  }
  async request(req) {
    let lastError;
    for (let attempt = 0;attempt <= this.retries; attempt++) {
      try {
        return await this.requestOnce(req);
      } catch (error) {
        lastError = error;
        if (attempt === this.retries || !isRetryable(error))
          throw error;
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  requestOnce(req) {
    const payload = Buffer.concat([Buffer.from(JSON.stringify(req), "utf8"), Buffer.from([0])]);
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`OAR daemon timeout after ${this.timeoutMs}ms (${this.socketPath})`));
      }, this.timeoutMs);
      socket.on("connect", () => {
        socket.write(payload);
      });
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf(0);
        if (idx === -1)
          return;
        clearTimeout(timer);
        const text = buf.subarray(0, idx).toString("utf8");
        socket.end();
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

// src/cli-flags.ts
function rejectUnknownFlags(args, allowed, valueFlags = new Set) {
  for (let i = 0;i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--"))
      continue;
    if (valueFlags.has(token)) {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`flag ${token} requires a value`);
      }
      i++;
      continue;
    }
    if (!allowed.has(token)) {
      throw new Error(`unknown flag: ${token}`);
    }
  }
}
function positionalArgs(args, valueFlags = new Set) {
  const out = [];
  for (let i = 0;i < args.length; i++) {
    const token = args[i];
    if (token.startsWith("--")) {
      if (valueFlags.has(token))
        i++;
      continue;
    }
    out.push(token);
  }
  return out;
}

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
function isCodexProvider(provider) {
  return resolveProvider(provider) === "chatgpt-subscription";
}
function isXaiProvider(provider) {
  return resolveProvider(provider) === "xai";
}

// src/import-all.ts
import { readFileSync } from "node:fs";

// src/provider-alias.ts
var PROVIDER_ALIASES2 = {
  "chatgpt-subscription": "chatgpt-subscription",
  "openai-codex": "chatgpt-subscription",
  openai: "chatgpt-subscription",
  codex: "chatgpt-subscription",
  chatgpt: "chatgpt-subscription",
  xai: "xai",
  grok: "xai"
};
function resolveProvider2(input) {
  const key = input.trim().toLowerCase();
  return PROVIDER_ALIASES2[key] ?? input.trim();
}
function isCodexProvider2(provider) {
  return resolveProvider2(provider) === "chatgpt-subscription";
}
function isXaiProvider2(provider) {
  return resolveProvider2(provider) === "xai";
}

// src/auth-slot.ts
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
  const canonical = resolveProvider2(provider);
  if (canonical === "chatgpt-subscription")
    return ["chatgpt-subscription", "openai-codex"];
  return [canonical];
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
function formatProfileLabel(profile, login) {
  return login ? `${profile}(${login})` : profile;
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

// src/import-all.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStoredCredential(value) {
  if (!isRecord2(value))
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
    raw = readFileSync(authPath, "utf8");
  } catch {
    throw new Error(`unable to read ${authPath}`);
  }
  try {
    const data = JSON.parse(raw);
    if (!isRecord2(data))
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
  if (isRecord2(auth)) {
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
  if (!isRecord2(data))
    return;
  const tokens = data.tokens;
  if (!isRecord2(tokens))
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
function importSelectionUsed(authPath, provider, account = "latest") {
  const data = parseAuthJsonFile(authPath);
  for (const key of authJsonKeysForProvider(provider)) {
    const slot = data[key];
    if (!isStoredCredential(slot))
      continue;
    return selectImportAccount(slot, provider, authPath, account).used;
  }
  return account;
}
function latestLoginSlotName(linked) {
  let best = 0;
  let name;
  for (const item of linked) {
    if (!isRecord2(item) || typeof item.name !== "string")
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
  if (!isRecord2(entry) || parent.type !== "oauth" || typeof entry.access !== "string") {
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
    return isRecord2(a) && a["name"] === selected;
  });
  if (idx < 0 || idx >= linked.length) {
    const names = linked.map((a, i) => isRecord2(a) && typeof a["name"] === "string" ? `${i + 1}=${a["name"]}` : `${i + 1}`).join(", ");
    throw new Error(`--account ${account} not found in ${provider} accounts[] (available: ${names})`);
  }
  return credentialFromSlotEntry(slot, linked[idx]);
}
function readAllCredentialsFromAuthJson(authPath) {
  const data = parseAuthJsonFile(authPath);
  const out = {};
  for (const [provider, value] of Object.entries(data)) {
    if (isStoredCredential(value)) {
      out[provider] = value;
    }
  }
  if (!out["chatgpt-subscription"] && out["openai-codex"]) {
    out["chatgpt-subscription"] = out["openai-codex"];
  }
  delete out["openai-codex"];
  if (!out["chatgpt-subscription"]) {
    const native = credentialFromNativeCodexAuth(data);
    if (native)
      out["chatgpt-subscription"] = native;
  }
  const canonical = {};
  for (const [provider, credential] of Object.entries(out)) {
    canonical[resolveProvider2(provider)] = credential;
  }
  return canonical;
}
async function importAllFromAuthJson(client, opts) {
  const credentials = readAllCredentialsFromAuthJson(opts.from);
  const imported = [];
  const skipped = [];
  const errors = [];
  for (const [provider, credential] of Object.entries(credentials)) {
    if (!opts.force) {
      const existing = await client.request({
        protocol: 1,
        action: "test",
        provider,
        profile: opts.profile
      });
      if (existing.ok) {
        const data = existing.data;
        if (data.availability && data.availability !== "REQUIRES_LOGIN") {
          skipped.push(provider);
          continue;
        }
      }
    }
    const res = await client.request({
      protocol: 1,
      action: "import-credential",
      provider,
      profile: opts.profile,
      credential
    });
    if (res.ok)
      imported.push(provider);
    else
      errors.push({ provider, error: res.error });
  }
  return { imported, skipped, errors };
}

// src/import-pref.ts
import { existsSync, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
function prefPath(root = defaultOarRoot()) {
  return join2(root, "import-account.json");
}
function readImportAccountSetting(root = defaultOarRoot()) {
  const path = prefPath(root);
  if (!existsSync(path))
    return "latest";
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return "primary";
    const account = parsed.account;
    return typeof account === "string" && account.length > 0 ? account : "latest";
  } catch {
    return "latest";
  }
}
function writeImportAccountSetting(account, root = defaultOarRoot()) {
  if (!account || account.startsWith("-"))
    throw new Error("import account setting must be primary, latest, or a slot name");
  mkdirSync(root, { recursive: true, mode: 448 });
  writeFileSync(prefPath(root), JSON.stringify({ account }, null, 2), { encoding: "utf8", mode: 384 });
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
// src/sinks/index.ts
function formatSinkResultLines(sinks) {
  return sinks.map((sink) => {
    const parts = [sink.id, sink.status];
    if (typeof sink.path === "string" && sink.path.length > 0)
      parts.push(sink.path);
    if (typeof sink.detail === "string" && sink.detail.length > 0)
      parts.push(sink.detail);
    return `sink: ${parts.join(" ")}`;
  });
}

// src/paths.ts
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
function defaultOarRoot2(env = process.env) {
  if (env.OAR_HOME)
    return env.OAR_HOME;
  return join3(homedir2(), ".oar");
}
function oarSocketPath2(root = defaultOarRoot2()) {
  return join3(root, "oar.sock");
}
function unique(paths) {
  const out = [];
  for (const p of paths) {
    if (!out.includes(p))
      out.push(p);
  }
  return out;
}
function resolveActiveAuthPaths2(env = process.env, home = homedir2()) {
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
  const selected = envDirs.length > 0 ? envDirs.map((dir) => join3(dir, "auth.json")) : [];
  const targets = unique([...selected, ...existing]);
  if (targets.length > 0)
    return targets;
  return [join3(home, ".omo", "agent", "auth.json")];
}
function knownAuthJsonCandidates(home) {
  return unique([
    join3(home, ".omo", "agent", "auth.json"),
    join3(home, ".omo", "auth.json"),
    join3(home, ".senpi", "agent", "auth.json"),
    join3(home, ".senpi", "remote-agent", "auth.json")
  ]);
}
function discoverAuthJsonFiles(env = process.env, home = homedir2()) {
  return unique([...resolveActiveAuthPaths2(env, home), ...knownAuthJsonCandidates(home)]).filter((p) => existsSync2(p));
}

// src/senpi-install.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { createRequire } from "node:module";
import { homedir as homedir3 } from "node:os";
import { dirname, join as join4 } from "node:path";
var KNOWN_OMO = "/opt/homebrew/lib/node_modules/omo-ai";
function readJson(path) {
  return JSON.parse(readFileSync3(path, "utf8"));
}
function fromOmoRoot(omoRoot) {
  const omoPkg = join4(omoRoot, "package.json");
  const senpiRoot = join4(omoRoot, "node_modules", "@code-yeongyu", "senpi");
  const senpiPkg = join4(senpiRoot, "package.json");
  const authStoragePath = join4(senpiRoot, "dist", "core", "auth-storage.js");
  const pluginRoot = join4(omoRoot, "plugin");
  if (!existsSync3(omoPkg) || !existsSync3(senpiPkg) || !existsSync3(authStoragePath))
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
function findSenpiInstall2() {
  const require2 = createRequire(import.meta.url);
  const candidates = [];
  try {
    candidates.push(dirname(require2.resolve("omo-ai/package.json")));
  } catch {}
  candidates.push(KNOWN_OMO);
  const homebrew = join4(homedir3(), ".nvm", "versions");
  if (existsSync3(homebrew)) {}
  for (const root of candidates) {
    const found = fromOmoRoot(root);
    if (found)
      return found;
  }
  return null;
}

// src/panel.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";

// src/table.ts
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function cellWidth(s) {
  return [...stripAnsi(s)].length;
}
function padCell(s, width, align) {
  const w = cellWidth(s);
  if (w >= width)
    return s;
  const pad = " ".repeat(width - w);
  return align === "right" ? pad + s : s + pad;
}
function formatMarkdownTable(columns, rows) {
  const headers = columns.map((c) => c.header);
  const data = rows.map((row) => columns.map((c) => {
    const v = row[c.key];
    if (v == null)
      return "-";
    if (v === "")
      return "";
    return String(v);
  }));
  const widths = columns.map((c, i) => {
    let w = Math.max(3, c.minWidth ?? 0, cellWidth(c.header));
    for (const r of data)
      w = Math.max(w, cellWidth(r[i] ?? ""));
    return w;
  });
  const line = (cells, align = columns.map((c) => c.align ?? "left")) => `| ${cells.map((cell, i) => padCell(cell, widths[i], align[i] ?? "left")).join(" | ")} |`;
  const sep = `| ${widths.map((w, i) => {
    const a = columns[i]?.align ?? "left";
    if (a === "right")
      return "-".repeat(Math.max(3, w - 1)) + ":";
    return "-".repeat(Math.max(3, w));
  }).join(" | ")} |`;
  const out = [line(headers), sep];
  for (const r of data)
    out.push(line(r));
  return out.join(`
`);
}

// src/panel.ts
function keyOf(provider, profile) {
  return `${provider}\x00${profile}`;
}
function readEventLines(eventsPath, opts) {
  if (!existsSync4(eventsPath))
    return [];
  const raw = readFileSync4(eventsPath, "utf8");
  if (!raw.trim())
    return [];
  const maxLines = opts?.maxLines ?? 50000;
  const all = raw.split(`
`).filter(Boolean);
  const slice = all.length > maxLines ? all.slice(all.length - maxLines) : all;
  const since = opts?.sinceMs ?? 0;
  const out = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line);
      if (since > 0 && parsed.ts) {
        const t = Date.parse(parsed.ts);
        if (Number.isFinite(t) && t < since)
          continue;
      }
      out.push(parsed);
    } catch {}
  }
  return out;
}
function aggregateUsage(events) {
  const map = new Map;
  const touch = (provider, profile) => {
    if (!provider || !profile)
      return null;
    const k = keyOf(provider, profile);
    let row = map.get(k);
    if (!row) {
      row = {
        provider,
        profile,
        success: 0,
        rateLimited: 0,
        quotaExhausted: 0,
        authFailed: 0,
        failover: 0,
        switches: 0
      };
      map.set(k, row);
    }
    return row;
  };
  for (const ev of events) {
    const row = touch(ev.provider, ev.profile);
    if (!row)
      continue;
    if (ev.ts) {
      row.lastEventAt = ev.ts;
    }
    const event = ev.event ?? "";
    const reason = (ev.reason ?? "").toUpperCase();
    if (event === "use" || event === "activate") {
      row.switches += 1;
      row.lastResult = event;
    } else if (event === "failover") {
      row.failover += 1;
      row.lastResult = "failover";
    } else if (event === "report") {
      row.lastResult = reason || "report";
      if (reason === "SUCCESS")
        row.success += 1;
      else if (reason === "RATE_LIMITED")
        row.rateLimited += 1;
      else if (reason === "QUOTA_EXHAUSTED")
        row.quotaExhausted += 1;
      else if (reason === "AUTH_REVOKED" || reason === "AUTH_EXPIRED")
        row.authFailed += 1;
    } else if (event === "refresh_failed") {
      row.authFailed += 1;
      row.lastResult = reason || "refresh_failed";
    }
  }
  return map;
}
function emptyUsage(provider, profile) {
  return {
    provider,
    profile,
    success: 0,
    rateLimited: 0,
    quotaExhausted: 0,
    authFailed: 0,
    failover: 0,
    switches: 0
  };
}
function buildPanelSnapshot(status, opts) {
  const windowHours = opts?.windowHours ?? 24;
  const sinceMs = Date.now() - windowHours * 3600000;
  const eventsPath = opts?.eventsPath ?? (opts?.rootDir ? oarEventsPath(opts.rootDir) : oarEventsPath());
  const usageMap = aggregateUsage(readEventLines(eventsPath, { sinceMs }));
  const remoteMap = new Map;
  for (const r of opts?.remoteUsage ?? []) {
    remoteMap.set(`${r.provider}\x00${r.profile}`, r);
  }
  const activeByProvider = new Map;
  for (const r of status.resolvePreview ?? []) {
    if (r.status === "available" && r.profile)
      activeByProvider.set(r.provider, r.profile);
  }
  const policies = status.state?.providers ?? {};
  const rows = [];
  for (const account of status.accounts ?? []) {
    const policy = policies[account.provider] ?? { mode: "manual", autoFailover: false };
    const usage = usageMap.get(keyOf(account.provider, account.profile)) ?? emptyUsage(account.provider, account.profile);
    rows.push({
      provider: account.provider,
      profile: account.profile,
      login: account.login,
      auth: account.auth,
      availability: account.availability,
      mode: policy.mode ?? "manual",
      autoFailover: Boolean(policy.autoFailover),
      preferred: policy.preferred === account.profile,
      active: activeByProvider.get(account.provider) === account.profile,
      lastUsedAt: account.lastUsedAt,
      until: account.until,
      reason: account.reason,
      usage,
      remote: remoteMap.get(`${account.provider}\x00${account.profile}`)
    });
  }
  rows.sort((a, b) => {
    if (a.provider !== b.provider)
      return a.provider.localeCompare(b.provider);
    if (a.active !== b.active)
      return a.active ? -1 : 1;
    if (a.preferred !== b.preferred)
      return a.preferred ? -1 : 1;
    return a.profile.localeCompare(b.profile);
  });
  const totals = {
    accounts: rows.length,
    active: rows.filter((r) => r.active).length,
    success: rows.reduce((n, r) => n + r.usage.success, 0),
    rateLimited: rows.reduce((n, r) => n + r.usage.rateLimited, 0),
    quotaExhausted: rows.reduce((n, r) => n + r.usage.quotaExhausted, 0),
    authFailed: rows.reduce((n, r) => n + r.usage.authFailed, 0)
  };
  return {
    generatedAt: new Date().toISOString(),
    windowHours,
    authPaths: status.authPaths ?? [],
    rows,
    leases: status.leases ?? [],
    totals,
    notes: [
      "ACTIVE * = currently preferred/resolved live slot for that provider (shared by all omo sessions).",
      "ok/rl/quota/auth = local OAR event signals in the time window.",
      "5H/WK/GROK% = remote plan windows (Codex WHAM usage; xAI Grok subscription billing). Session/5h shows - when provider only exposes weekly.",
      "Use: oar usage  |  oar panel --refresh"
    ]
  };
}
function remoteCols(r) {
  const remote = r.remote;
  if (!remote?.ok) {
    if (remote && !remote.ok && remote.error) {
      return { session: "err", weekly: "err", grok: "err" };
    }
    return { session: "-", weekly: "-", grok: "-" };
  }
  const session = remote.windows.find((w) => w.kind === "session");
  const weekly = remote.windows.find((w) => w.kind === "weekly");
  const grok = remote.windows.find((w) => w.label === "grok" || isXaiProvider2(r.provider) && (w.kind === "weekly" || w.kind === "period"));
  const fmt = (w) => {
    if (!w)
      return "-";
    if (w.remainingPercent != null)
      return `${w.remainingPercent}%`;
    if (w.usedPercent != null)
      return `${Math.max(0, 100 - w.usedPercent)}%`;
    return "-";
  };
  return {
    session: isCodexProvider2(r.provider) ? fmt(session) : "-",
    weekly: isCodexProvider2(r.provider) ? fmt(weekly) : "-",
    grok: isXaiProvider2(r.provider) ? fmt(grok) : "-"
  };
}
function formatPanelText(snap) {
  const lines = [];
  lines.push(`OAR panel  -  window ${snap.windowHours}h  -  ${snap.generatedAt}`);
  lines.push(`accounts ${snap.totals.accounts}  active ${snap.totals.active}  ok ${snap.totals.success}  rl ${snap.totals.rateLimited}  quota ${snap.totals.quotaExhausted}  authfail ${snap.totals.authFailed}`);
  lines.push("");
  lines.push(formatMarkdownTable([
    { key: "active", header: "" },
    { key: "provider", header: "PROVIDER" },
    { key: "profile", header: "PROFILE" },
    { key: "status", header: "STATUS" },
    { key: "mode", header: "MODE" },
    { key: "auto", header: "AUTO" },
    { key: "session", header: "5H left", align: "right" },
    { key: "weekly", header: "WK left", align: "right" },
    { key: "grok", header: "GROK left", align: "right" },
    { key: "ok", header: "OK", align: "right" },
    { key: "rl", header: "RL", align: "right" }
  ], snap.rows.map((r) => {
    const rc = remoteCols(r);
    return {
      active: r.active ? "*" : r.preferred ? "." : "",
      provider: r.provider,
      profile: formatProfileLabel(r.profile, r.login),
      status: r.availability,
      mode: r.mode,
      auto: r.autoFailover ? "on" : "off",
      session: rc.session,
      weekly: rc.weekly,
      grok: rc.grok,
      ok: r.usage.success,
      rl: r.usage.rateLimited
    };
  })));
  if (snap.leases.length > 0) {
    lines.push("");
    lines.push("leases:");
    lines.push(formatMarkdownTable([
      { key: "provider", header: "PROVIDER" },
      { key: "profile", header: "PROFILE" },
      { key: "holder", header: "HOLDER" },
      { key: "since", header: "SINCE" }
    ], snap.leases.map((l) => ({
      provider: l.provider,
      profile: l.profile,
      holder: l.holder,
      since: l.acquiredAt
    }))));
  }
  lines.push("");
  lines.push("auth paths:");
  for (const p of snap.authPaths)
    lines.push(`  ${p}`);
  lines.push("");
  for (const n of snap.notes)
    lines.push(`note: ${n}`);
  return lines.join(`
`);
}
function formatPanelXbar(snap) {
  const active = snap.rows.filter((r) => r.active);
  const titleParts = active.map((r) => `${shortProv(r.provider)}:${r.profile}`);
  const title = titleParts.length > 0 ? `OAR ${titleParts.join(" ")}` : "OAR";
  const lines = [title, "---"];
  lines.push(`Refresh panel | bash=/usr/bin/true refresh=true`);
  lines.push(`Window: last ${snap.windowHours}h | size=12`);
  lines.push("---");
  let lastProv = "";
  for (const r of snap.rows) {
    if (r.provider !== lastProv) {
      lines.push(`${r.provider}  mode=${r.mode} auto=${r.autoFailover ? "on" : "off"} | size=12`);
      lastProv = r.provider;
    }
    const star = r.active ? "* " : "  ";
    const rc = remoteCols(r);
    const remote = isCodexProvider2(r.provider) ? `5h=${rc.session} wk=${rc.weekly}` : isXaiProvider2(r.provider) ? `grok=${rc.grok}` : "";
    const stats = `ok=${r.usage.success} rl=${r.usage.rateLimited}${remote ? " " + remote : ""}`;
    lines.push(`${star}${formatProfileLabel(r.profile, r.login)}  ${r.availability}  ${stats} | bash=${shellQuote(process.env.HOME + "/.local/bin/oar")} param1=use param2=${r.provider} param3=${r.profile} terminal=false refresh=true`);
  }
  lines.push("---");
  lines.push("Open status in terminal | bash=" + shellQuote((process.env.HOME || "") + "/.local/bin/oar") + " param1=panel terminal=true");
  lines.push("Doctor | bash=" + shellQuote((process.env.HOME || "") + "/.local/bin/oar") + " param1=doctor terminal=true");
  lines.push("---");
  lines.push("Local event signals only - not provider $ billing");
  return lines.join(`
`);
}
function shortProv(p) {
  if (isCodexProvider2(p))
    return "codex";
  if (p === "zai-coding-cn")
    return "zai";
  if (p === "opencode-go")
    return "ocgo";
  return p;
}
function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// src/status-format.ts
var PROBLEMATIC_AVAIL = new Set([
  "QUOTA_EXHAUSTED",
  "AUTH_EXPIRED",
  "AUTH_REVOKED",
  "RATE_LIMITED"
]);
var ANSI = {
  reset: "\x1B[0m",
  dim: "\x1B[2m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m"
};
function isProblematicAccount(account) {
  if (PROBLEMATIC_AVAIL.has(account.availability))
    return true;
  return account.auth === "expired" || account.auth === "revoked";
}
function shortUntil(iso) {
  if (!iso)
    return;
  const t = Date.parse(iso);
  if (!Number.isFinite(t))
    return iso;
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}
function buildNote(account) {
  const until = shortUntil(account.until);
  const reason = account.reason?.trim() || undefined;
  if (reason && until)
    return `${reason} · until ${until}`;
  if (reason)
    return reason;
  if (until)
    return `until ${until}`;
  return "";
}
function buildStatusView(data) {
  const activeByProvider = new Map(data.resolvePreview.map((r) => [r.provider, r.profile]));
  const rows = data.accounts.map((account) => {
    const pol = data.state.providers[account.provider];
    const active = activeByProvider.get(account.provider) === account.profile;
    return {
      active,
      provider: account.provider,
      profile: account.profile,
      login: account.login,
      auth: account.auth,
      availability: account.availability,
      mode: pol?.mode ?? "manual",
      autoFailover: Boolean(pol?.autoFailover),
      preferred: pol?.preferred === account.profile,
      until: account.until ?? null,
      reason: account.reason,
      lastChecked: account.lastChecked,
      note: buildNote(account)
    };
  });
  rows.sort((a, b) => {
    if (a.provider !== b.provider)
      return a.provider.localeCompare(b.provider);
    if (a.active !== b.active)
      return a.active ? -1 : 1;
    return a.profile.localeCompare(b.profile);
  });
  return {
    summary: {
      accounts: rows.length,
      active: rows.filter((r) => r.active).length,
      problematic: rows.filter((r) => isProblematicAccount(r)).length
    },
    rows,
    authPaths: data.authPaths ?? []
  };
}
function statusViewToJson(view) {
  return {
    summary: view.summary,
    rows: view.rows.map((r) => ({
      active: r.active,
      provider: r.provider,
      profile: r.profile,
      login: r.login ?? null,
      auth: r.auth,
      status: r.availability,
      mode: r.mode,
      auto: r.autoFailover,
      preferred: r.preferred,
      note: r.note,
      until: r.until ?? null,
      reason: r.reason ?? null
    })),
    authPaths: view.authPaths
  };
}
function paint(enabled, code, text) {
  if (!enabled || text === "")
    return text;
  return `${code}${text}${ANSI.reset}`;
}
function colorAuth(enabled, auth) {
  if (auth === "valid")
    return paint(enabled, ANSI.green, auth);
  if (auth === "expired" || auth === "revoked")
    return paint(enabled, ANSI.red, auth);
  return paint(enabled, ANSI.dim, auth);
}
function colorStatus(enabled, availability) {
  if (PROBLEMATIC_AVAIL.has(availability))
    return paint(enabled, ANSI.red, availability);
  if (availability === "AVAILABLE" || availability === "ACTIVE") {
    return paint(enabled, ANSI.green, availability);
  }
  if (availability === "COOLDOWN" || availability === "REQUIRES_LOGIN") {
    return paint(enabled, ANSI.yellow, availability);
  }
  return availability;
}
function wantStatusColor(env = process.env, stdout = process.stdout) {
  return Boolean(stdout.isTTY) && !env.NO_COLOR;
}
function formatStatusText(view, opts) {
  const color = opts?.color ?? false;
  const lines = [];
  const { accounts, active, problematic } = view.summary;
  lines.push(`OAR status  ·  accounts ${accounts}  active ${active}  problematic ${problematic}`);
  lines.push("");
  lines.push(formatMarkdownTable([
    { key: "active", header: "" },
    { key: "provider", header: "PROVIDER" },
    { key: "profile", header: "PROFILE" },
    { key: "auth", header: "AUTH" },
    { key: "status", header: "STATUS" },
    { key: "mode", header: "MODE" },
    { key: "auto", header: "AUTO" },
    { key: "note", header: "NOTE" }
  ], view.rows.map((r) => ({
    active: r.active ? "*" : "",
    provider: r.provider,
    profile: formatProfileLabel(r.profile, r.login),
    auth: colorAuth(color, r.auth),
    status: colorStatus(color, r.availability),
    mode: r.mode,
    auto: r.autoFailover ? "on" : "off",
    note: r.note
  }))));
  lines.push("");
  lines.push("Legend:");
  lines.push("  AUTH    Vault/import health (valid | expired | revoked | unknown).");
  lines.push("  STATUS  Routing eligibility (AVAILABLE, QUOTA_EXHAUSTED, RATE_LIMITED, …).");
  lines.push("  ACTIVE  * = live auth slot for that provider (target of oar use).");
  lines.push("  NOTE    Stale AUTH hints when vault token expired but metadata still valid.");
  lines.push("");
  lines.push("Next: oar panel --refresh | oar usage | oar use <provider> <profile>");
  lines.push("");
  lines.push("auth paths (active slot writes):");
  if (view.authPaths.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of view.authPaths)
      lines.push(`  ${p}`);
  }
  return lines.join(`
`);
}

// src/store.ts
import {
  chmodSync,
  existsSync as existsSync5,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync5,
  renameSync,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";
var DEFAULT_POLICY = {
  mode: "manual",
  autoFailover: false
};
function emptyState() {
  return { version: 1, providers: {}, accounts: [], updatedAt: new Date().toISOString() };
}
function atomicWriteJson2(path, data, mode = 384) {
  mkdirSync2(dirname2(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync2(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
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
    mkdirSync2(this.rootDir, { recursive: true, mode: 448 });
    mkdirSync2(this.vaultDir, { recursive: true, mode: 448 });
    this.state = this.load();
    if (this.migrateLegacyProviders())
      this.persist();
  }
  migrateLegacyProviders() {
    let changed = false;
    const accounts = this.state.accounts.map((account) => {
      const provider = resolveProvider2(account.provider);
      if (provider === account.provider)
        return account;
      changed = true;
      this.renameVaultFile(account.provider, provider, account.profile);
      return { ...account, provider, credentialRef: `vault:${provider}:${account.profile}` };
    });
    const providers = {};
    for (const [key, policy] of Object.entries(this.state.providers)) {
      const provider = resolveProvider2(key);
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
    const oldPath = join5(this.vaultDir, `${from}__${profile}.json`);
    const nextPath = join5(this.vaultDir, `${to}__${profile}.json`);
    if (existsSync5(oldPath) && !existsSync5(nextPath))
      renameSync(oldPath, nextPath);
  }
  load() {
    if (!existsSync5(this.statePath))
      return emptyState();
    try {
      const parsed = JSON.parse(readFileSync5(this.statePath, "utf8"));
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
    const canonical = resolveProvider2(provider);
    return this.state.accounts.filter((a) => resolveProvider2(a.provider) === canonical);
  }
  getAccount(provider, profile) {
    const canonical = resolveProvider2(provider);
    return this.state.accounts.find((a) => resolveProvider2(a.provider) === canonical && a.profile === profile);
  }
  upsertAccount(account) {
    const provider = resolveProvider2(account.provider);
    const next = provider === account.provider ? account : { ...account, provider, credentialRef: `vault:${provider}:${account.profile}` };
    const idx = this.state.accounts.findIndex((a) => resolveProvider2(a.provider) === provider && a.profile === next.profile);
    account = next;
    if (idx >= 0)
      this.state.accounts[idx] = account;
    else
      this.state.accounts.push(account);
    this.persist();
  }
  removeAccount(provider, profile) {
    const canonical = resolveProvider2(provider);
    const vaultPath = this.vaultPath(canonical, profile);
    const legacyPath = join5(this.vaultDir, `${provider}__${profile}.json`);
    if (existsSync5(vaultPath)) {
      unlinkSync(vaultPath);
    }
    if (legacyPath !== vaultPath && existsSync5(legacyPath))
      unlinkSync(legacyPath);
    this.state.accounts = this.state.accounts.filter((a) => !(resolveProvider2(a.provider) === canonical && a.profile === profile));
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
    const canonical = resolveProvider2(provider);
    return { ...DEFAULT_POLICY, ...this.state.providers[canonical] ?? this.state.providers[provider] ?? {} };
  }
  setProviderMode(provider, mode) {
    const canonical = resolveProvider2(provider);
    const cur = this.getProviderPolicy(canonical);
    this.state.providers[canonical] = { ...cur, mode };
    this.persist();
  }
  setAutoFailover(provider, enabled) {
    const canonical = resolveProvider2(provider);
    const cur = this.getProviderPolicy(canonical);
    this.state.providers[canonical] = { ...cur, autoFailover: enabled };
    this.persist();
  }
  setPreferred(provider, profile) {
    const canonical = resolveProvider2(provider);
    const cur = this.getProviderPolicy(canonical);
    this.state.providers[canonical] = { ...cur, preferred: profile };
    this.persist();
  }
  vaultPath(provider, profile) {
    return join5(this.vaultDir, `${resolveProvider2(provider)}__${profile}.json`);
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
    if (!existsSync5(path))
      return;
    try {
      return JSON.parse(readFileSync5(path, "utf8"));
    } catch {
      return;
    }
  }
}

// src/who.ts
import { existsSync as existsSync6, readFileSync as readFileSync6 } from "node:fs";
function isCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const type = value.type;
  return type === "oauth" || type === "api_key";
}
function sameAccount(live, vault) {
  if (credentialsSameSecrets(live, vault))
    return true;
  return live.type === "oauth" && vault.type === "oauth" && Boolean(live.refresh) && live.refresh === vault.refresh;
}
function slotName(slot) {
  const accounts = slot.accounts;
  if (!Array.isArray(accounts))
    return "-";
  for (const item of accounts) {
    if (!item || typeof item !== "object")
      continue;
    const name = item.name;
    if (typeof name !== "string" || !name)
      continue;
    const access = item.access;
    const refresh = item.refresh;
    const key = item.key;
    if (slot.type === "oauth" && (access === slot.access || refresh === slot.refresh))
      return name;
    if (slot.type === "api_key" && key === slot.key)
      return name;
  }
  return "-";
}
function describeLiveAuth(paths, accounts, readVault) {
  const rows = [];
  for (const path of paths) {
    if (!existsSync6(path))
      continue;
    let data;
    try {
      const parsed = JSON.parse(readFileSync6(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      data = parsed;
    } catch {
      rows.push({ path, provider: "-", profile: "-", login: "-", slot: "-", note: "unreadable" });
      continue;
    }
    for (const [provider, raw] of Object.entries(data)) {
      if (!isCredential(raw))
        continue;
      const canonical = resolveProvider2(provider);
      const match = accounts.find((account) => {
        if (resolveProvider2(account.provider) !== canonical)
          return false;
        const vault = readVault(account.provider, account.profile);
        return vault ? sameAccount(raw, vault) : false;
      });
      const login = loginFromCredential(raw) ?? match?.login ?? "-";
      const slot = slotName(raw);
      rows.push({
        path,
        provider,
        profile: match?.profile ?? "-",
        login,
        slot,
        note: match ? "live token" : "no vault match"
      });
    }
  }
  return rows;
}
function formatWho(rows) {
  if (rows.length === 0)
    return "no live auth slots";
  const lines = ["PATH  PROVIDER  OAR  LOGIN  SLOT  NOTE"];
  for (const row of rows) {
    lines.push([row.path, row.provider, row.profile, row.login, row.slot, row.note].join("  "));
  }
  lines.push("");
  lines.push("OAR is the vault profile whose token is in the file. SLOT is the Senpi accounts[] name only when that entry holds the same token. The footer @login-N is a per-session label and can differ.");
  return lines.join(`
`);
}

// src/usage/cache.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync3, readFileSync as readFileSync7, renameSync as renameSync2, writeFileSync as writeFileSync3, chmodSync as chmodSync2 } from "node:fs";
import { dirname as dirname3, join as join6 } from "node:path";
function usageCachePath(root = defaultOarRoot()) {
  return join6(root, "usage-cache.json");
}
function cacheKey(provider, profile) {
  return `${provider}/${profile}`;
}
function loadUsageCache(root = defaultOarRoot()) {
  const path = usageCachePath(root);
  if (!existsSync7(path))
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
  mkdirSync3(dirname3(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: cache.entries
  };
  writeFileSync3(tmp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 384 });
  renameSync2(tmp, path);
  try {
    chmodSync2(path, 384);
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
    putCachedUsage(miss, root);
    return miss;
  }
  let result;
  if (resolveProvider2(provider) === "chatgpt-subscription") {
    result = await fetchCodexUsage(provider, profile, cred, { fetchImpl: opts?.fetchImpl });
  } else if (resolveProvider2(provider) === "xai") {
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

// src/usage/format.ts
function fmtPct(n) {
  if (n == null || !Number.isFinite(n))
    return "-";
  return `${n}%`;
}
function shortReset(iso) {
  if (!iso)
    return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t))
    return "-";
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}
function pick(windows, pred) {
  return windows.find(pred);
}
function formatUsageTable(rows) {
  if (rows.length === 0)
    return "(no usage rows)";
  const table = formatMarkdownTable([
    { key: "provider", header: "PROVIDER" },
    { key: "profile", header: "PROFILE" },
    { key: "ok", header: "OK" },
    { key: "session", header: "5H left", align: "right" },
    { key: "weekly", header: "WK left", align: "right" },
    { key: "grok", header: "GROK left", align: "right" },
    { key: "used", header: "USED", align: "right" },
    { key: "reset", header: "RESET" },
    { key: "source", header: "SOURCE" },
    { key: "note", header: "NOTE" }
  ], rows.map((u) => {
    if (!u.ok) {
      return {
        provider: u.provider,
        profile: u.profile,
        ok: "no",
        session: "-",
        weekly: "-",
        grok: "-",
        used: "-",
        reset: "-",
        source: u.source,
        note: u.error ?? "error"
      };
    }
    const session = pick(u.windows, (w) => w.kind === "session");
    const weekly = pick(u.windows, (w) => w.kind === "weekly");
    const grok = pick(u.windows, (w) => w.label === "grok" || isXaiProvider2(u.provider) && (w.kind === "weekly" || w.kind === "period"));
    const primary = isXaiProvider2(u.provider) ? grok : weekly ?? session ?? u.windows[0];
    return {
      provider: u.provider,
      profile: u.profile,
      ok: "yes",
      session: isCodexProvider2(u.provider) ? fmtPct(session?.remainingPercent) : "-",
      weekly: isCodexProvider2(u.provider) ? fmtPct(weekly?.remainingPercent) : "-",
      grok: isXaiProvider2(u.provider) ? fmtPct(grok?.remainingPercent) : "-",
      used: fmtPct(primary?.usedPercent),
      reset: shortReset(primary?.resetsAt),
      source: u.source,
      note: primary?.limitReached ? "LIMIT" : ""
    };
  }));
  return [
    "OAR usage (remaining %)",
    table,
    "",
    "5H = Codex session/short window when exposed; WK = Codex weekly; GROK = xAI Grok subscription credits.",
    "- means the provider did not return that window (common: Codex weekly-only plans)."
  ].join(`
`);
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

// src/usage/fetch.ts
function applyUsageToAccountState2(store, usage) {
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
async function fetchRemoteUsage2(store, provider, profile, opts) {
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
    putCachedUsage(miss, root);
    return miss;
  }
  let result;
  if (resolveProvider2(provider) === "chatgpt-subscription") {
    result = await fetchCodexUsage(provider, profile, cred, { fetchImpl: opts?.fetchImpl });
  } else if (resolveProvider2(provider) === "xai") {
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
  applyUsageToAccountState2(store, result);
  return result;
}
async function fetchRemoteUsageForAccounts2(store, accounts, opts) {
  const out = [];
  const queue = [...accounts];
  const workers = Math.min(3, queue.length || 1);
  async function worker() {
    while (queue.length) {
      const next = queue.shift();
      if (!next)
        return;
      out.push(await fetchRemoteUsage2(store, next.provider, next.profile, opts));
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

// src/usage/recommend.ts
function primaryWindow(u) {
  if (!u?.ok || u.windows.length === 0) {
    return { remainingPercent: null, usedPercent: null, label: "-", resetsAt: null };
  }
  const ranked = [...u.windows].sort((a, b) => {
    const ar = a.remainingPercent ?? -1;
    const br = b.remainingPercent ?? -1;
    return br - ar;
  });
  const w = ranked.find((x) => x.remainingPercent != null) ?? ranked[0];
  return {
    remainingPercent: w.remainingPercent,
    usedPercent: w.usedPercent,
    label: w.label ?? w.kind,
    resetsAt: w.resetsAt
  };
}
function scoreAccount(account, usage, preferred) {
  const win = primaryWindow(usage);
  let score = 0;
  const notes = [];
  if (!isEligible(account)) {
    score = -1000;
    notes.push(account.availability === "QUOTA_EXHAUSTED" ? "0%/exhausted" : account.availability);
  } else {
    score += 100;
  }
  if (win.remainingPercent != null) {
    score += win.remainingPercent;
    if (win.remainingPercent <= 0) {
      score -= 500;
      notes.push("remote 0%");
    } else if (win.remainingPercent <= 5) {
      notes.push("low remaining");
    }
  } else if (usage && !usage.ok) {
    score += 10;
    notes.push(usage.error ? `usage err` : "no remote %");
  } else {
    score += 15;
    notes.push("no remote %");
  }
  if (preferred && account.profile === preferred && isEligible(account)) {
    score += 5;
    notes.push("preferred");
  }
  if (account.availability === "ACTIVE") {
    score += 2;
  }
  return {
    score,
    note: notes.join(", ") || "ok",
    remainingPercent: win.remainingPercent,
    usedPercent: win.usedPercent,
    label: win.label,
    resetsAt: win.resetsAt
  };
}
async function buildRecommendations(store, opts) {
  const root = opts?.root ?? defaultOarRoot();
  let accounts = store.listAccounts();
  if (opts?.providers?.length) {
    const set = new Set(opts.providers);
    accounts = accounts.filter((a) => set.has(a.provider));
  }
  const targets = accounts.filter((a) => isXaiProvider2(a.provider) || isCodexProvider2(a.provider)).map((a) => ({ provider: a.provider, profile: a.profile }));
  const usageList = targets.length > 0 ? await fetchRemoteUsageForAccounts2(store, targets, {
    root,
    force: opts?.force ?? true,
    maxAgeMs: opts?.force ? 0 : 60000
  }) : [];
  const usageMap = new Map(usageList.map((u) => [`${u.provider}\x00${u.profile}`, u]));
  const preferredByProvider = new Map;
  for (const a of accounts) {
    if (!preferredByProvider.has(a.provider)) {
      preferredByProvider.set(a.provider, store.getProviderPolicy(a.provider).preferred);
    }
  }
  const scored = accounts.map((a) => {
    const u = usageMap.get(`${a.provider}\x00${a.profile}`);
    const preferred = preferredByProvider.get(a.provider);
    const s = scoreAccount(a, u, preferred);
    const live = preferred === a.profile && a.availability === "ACTIVE";
    return {
      provider: a.provider,
      profile: a.profile,
      remainingPercent: s.remainingPercent,
      usedPercent: s.usedPercent,
      windowLabel: s.label,
      eligibility: isEligible(a) ? "ok" : a.availability,
      live,
      score: s.score,
      note: s.note,
      resetsAt: s.resetsAt
    };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score)
      return b.score - a.score;
    const ar = a.remainingPercent ?? -1;
    const br = b.remainingPercent ?? -1;
    if (br !== ar)
      return br - ar;
    return `${a.provider}/${a.profile}`.localeCompare(`${b.provider}/${b.profile}`);
  });
  return scored.map((row, i) => ({ ...row, rank: i + 1 }));
}

// src/subscriptions/audit.ts
function primaryUsage(u) {
  if (!u)
    return { remainingPercent: null, label: "-", ok: false };
  if (!u.ok) {
    return { remainingPercent: null, label: "-", ok: false, error: u.error };
  }
  const ranked = [...u.windows].sort((a, b) => (b.remainingPercent ?? -1) - (a.remainingPercent ?? -1));
  const w = ranked.find((x) => x.remainingPercent != null) ?? ranked[0];
  if (!w)
    return { remainingPercent: null, label: "-", ok: true };
  return {
    remainingPercent: w.remainingPercent,
    label: w.label ?? w.kind,
    ok: true
  };
}
function usageSummary(account, u) {
  const p = primaryUsage(u);
  if (!u)
    return account.availability;
  if (!u.ok)
    return u.error ?? "usage error";
  if (p.remainingPercent != null)
    return `${p.remainingPercent}% ${p.label}`;
  return account.availability;
}
function isAuthBroken(u) {
  if (!u || u.ok)
    return false;
  return /401|403|invalid_grant/i.test(u.error ?? "");
}
function classifyRow(account, plan, u, isTopPick, isActive, siblingHasEligible) {
  const monthly = plan?.monthlyUsd ?? null;
  const p = primaryUsage(u);
  if (monthly == null) {
    return {
      recommend: "unset cost",
      note: "run: oar subscriptions set … --monthly-usd <n>",
      savePerMonth: null
    };
  }
  if (isAuthBroken(u)) {
    if (siblingHasEligible) {
      return {
        recommend: "fix first",
        note: "usage auth error — re-auth before cancel; sibling can cover workload",
        savePerMonth: null
      };
    }
    return {
      recommend: "fix first",
      note: "usage auth error — oar doctor for remediation",
      savePerMonth: null
    };
  }
  if (account.availability === "QUOTA_EXHAUSTED" || p.remainingPercent != null && p.remainingPercent <= 0) {
    if (isTopPick || isActive) {
      return {
        recommend: "keep",
        note: "exhausted but primary/active — switch before cancel",
        savePerMonth: null
      };
    }
    if (siblingHasEligible) {
      return {
        recommend: "cancel candidate",
        note: "0% / exhausted with eligible sibling",
        savePerMonth: monthly
      };
    }
    return {
      recommend: "keep",
      note: "only eligible profile for provider — do not cancel all",
      savePerMonth: null
    };
  }
  if (isTopPick || isActive) {
    return { recommend: "keep", note: isActive ? "active slot" : "recommend top pick", savePerMonth: null };
  }
  if (isEligible(account) && p.remainingPercent != null && p.remainingPercent > 0) {
    return {
      recommend: "demote",
      note: "eligible duplicate — lower priority vs sibling",
      savePerMonth: null
    };
  }
  if (!isEligible(account) && siblingHasEligible) {
    return {
      recommend: "cancel candidate",
      note: `${account.availability} with sibling coverage`,
      savePerMonth: monthly
    };
  }
  return { recommend: "keep", note: "default keep (provider guard)", savePerMonth: null };
}
async function buildSubscriptionAudit(oarStore, subsStore, opts) {
  const root = opts?.root ?? oarStore.rootDir;
  const accounts = oarStore.listAccounts();
  const plans = subsStore.list();
  const planMap = new Map(plans.map((p) => [`${p.provider}\x00${p.profile}`, p]));
  const usageTargets = accounts.filter((a) => isXaiProvider2(a.provider) || isCodexProvider2(a.provider)).map((a) => ({ provider: a.provider, profile: a.profile }));
  const usageList = usageTargets.length > 0 ? await fetchRemoteUsageForAccounts2(oarStore, usageTargets, {
    root,
    force: opts?.force ?? false,
    maxAgeMs: opts?.force ? 0 : 300000
  }) : [];
  const usageMap = new Map(usageList.map((u) => [`${u.provider}\x00${u.profile}`, u]));
  const recommendRows = await buildRecommendations(oarStore, { root, force: opts?.force ?? false });
  const topPick = recommendRows.find((r) => r.score > 0 && r.eligibility === "ok");
  const topKey = topPick ? `${topPick.provider}\x00${topPick.profile}` : null;
  const activeByProvider = new Map;
  for (const r of recommendRows) {
    if (r.live)
      activeByProvider.set(r.provider, r.profile);
  }
  const eligibleByProvider = new Map;
  for (const a of accounts) {
    if (isEligible(a))
      eligibleByProvider.set(a.provider, true);
  }
  const rows = accounts.map((account) => {
    const key = `${account.provider}\x00${account.profile}`;
    const plan = planMap.get(key);
    const u = usageMap.get(key);
    const siblingHasEligible = accounts.filter((a) => a.provider === account.provider && a.profile !== account.profile).some(isEligible) || Boolean(eligibleByProvider.get(account.provider));
    const isTopPick = topKey === key;
    const isActive = activeByProvider.get(account.provider) === account.profile;
    const { recommend, note, savePerMonth } = classifyRow(account, plan, u, isTopPick, isActive, siblingHasEligible);
    return {
      provider: account.provider,
      profile: account.profile,
      planLabel: plan?.planLabel ?? "-",
      monthlyUsd: plan?.monthlyUsd ?? null,
      usageSummary: usageSummary(account, u),
      status: account.availability,
      recommend,
      savePerMonth,
      note
    };
  });
  rows.sort((a, b) => a.provider === b.provider ? a.profile.localeCompare(b.profile) : a.provider.localeCompare(b.provider));
  const totalConfiguredUsd = plans.reduce((s, p) => s + p.monthlyUsd, 0);
  const potentialSavingsUsd = rows.filter((r) => r.recommend === "cancel candidate" && r.savePerMonth != null).reduce((s, r) => s + (r.savePerMonth ?? 0), 0);
  const fmt = (r) => `${r.provider}/${r.profile}`;
  return {
    generatedAt: new Date().toISOString(),
    totalConfiguredUsd,
    potentialSavingsUsd,
    rows,
    summary: {
      keep: rows.filter((r) => r.recommend === "keep").map(fmt),
      cancel: rows.filter((r) => r.recommend === "cancel candidate").map(fmt),
      fix: rows.filter((r) => r.recommend === "fix first").map(fmt),
      demote: rows.filter((r) => r.recommend === "demote").map(fmt),
      unsetCost: rows.filter((r) => r.recommend === "unset cost").map(fmt)
    }
  };
}

// src/subscriptions/format.ts
function fmtUsd(n) {
  if (n == null || !Number.isFinite(n))
    return "-";
  return `$${n.toFixed(0)}`;
}
function formatSubscriptionsList(plans) {
  if (plans.length === 0) {
    return `OAR subscriptions
(no plans configured — oar subscriptions set <provider> <profile> --monthly-usd <n>)`;
  }
  const table = formatMarkdownTable([
    { key: "provider", header: "PROVIDER" },
    { key: "profile", header: "PROFILE" },
    { key: "usd", header: "$/MO", align: "right" },
    { key: "plan", header: "PLAN" },
    { key: "cycle", header: "CYCLE DAY", align: "right" }
  ], plans.map((p) => ({
    provider: p.provider,
    profile: p.profile,
    usd: fmtUsd(p.monthlyUsd),
    plan: p.planLabel ?? "-",
    cycle: p.billingCycleDay != null ? String(p.billingCycleDay) : "-"
  })));
  const total = plans.reduce((s, p) => s + p.monthlyUsd, 0);
  return ["OAR subscriptions", table, "", `total configured: ${fmtUsd(total)}/mo`, ""].join(`
`);
}
function formatAuditText(result) {
  const lines = [];
  lines.push(`OAR subscription audit  ·  total configured ${fmtUsd(result.totalConfiguredUsd)}/mo  ·  potential savings ${fmtUsd(result.potentialSavingsUsd)}/mo`);
  lines.push("");
  lines.push(formatMarkdownTable([
    { key: "provider", header: "PROVIDER" },
    { key: "profile", header: "PROFILE" },
    { key: "plan", header: "PLAN" },
    { key: "usd", header: "$/MO", align: "right" },
    { key: "usage", header: "USAGE" },
    { key: "status", header: "STATUS" },
    { key: "rec", header: "RECOMMEND" },
    { key: "save", header: "SAVE/MO", align: "right" },
    { key: "note", header: "NOTE" }
  ], result.rows.map((r) => ({
    provider: r.provider,
    profile: r.profile,
    plan: r.planLabel,
    usd: fmtUsd(r.monthlyUsd),
    usage: r.usageSummary,
    status: r.status,
    rec: r.recommend,
    save: r.savePerMonth != null ? fmtUsd(r.savePerMonth) : "-",
    note: r.note
  }))));
  lines.push("");
  lines.push("RECOMMENDATION SUMMARY");
  if (result.summary.keep.length)
    lines.push(`  keep:     ${result.summary.keep.join(", ")}`);
  if (result.summary.cancel.length) {
    lines.push(`  cancel:   ${result.summary.cancel.join(", ")}`);
  }
  if (result.summary.fix.length)
    lines.push(`  fix:      ${result.summary.fix.join(", ")}`);
  if (result.summary.demote.length)
    lines.push(`  demote:   ${result.summary.demote.join(", ")}`);
  if (result.summary.unsetCost.length) {
    lines.push(`  unset:    ${result.summary.unsetCost.join(", ")} (add monthly cost)`);
  }
  lines.push("");
  lines.push("Heuristic only — not financial advice. Provider must keep ≥1 eligible profile.");
  lines.push('  oar subscriptions set <provider> <profile> --monthly-usd <n> [--plan "…"]');
  lines.push("  oar doctor   # codex auth remediation");
  return lines.join(`
`);
}
function auditToJson(result) {
  return result;
}

// src/subscriptions/store.ts
import {
  chmodSync as chmodSync3,
  existsSync as existsSync8,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync8,
  renameSync as renameSync3,
  writeFileSync as writeFileSync4
} from "node:fs";
import { dirname as dirname4, join as join7 } from "node:path";
function emptyFile() {
  return { version: 1, plans: [], updatedAt: new Date().toISOString() };
}
function atomicWriteJson3(path, data, mode = 384) {
  mkdirSync4(dirname4(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync4(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync3(tmp, path);
  try {
    chmodSync3(path, mode);
  } catch {}
}
function subscriptionsPath(root = defaultOarRoot()) {
  return join7(root, "subscriptions.json");
}

class SubscriptionsStore {
  rootDir;
  path;
  constructor(opts) {
    this.rootDir = opts?.rootDir ?? defaultOarRoot();
    this.path = subscriptionsPath(this.rootDir);
  }
  load() {
    if (!existsSync8(this.path))
      return emptyFile();
    try {
      const parsed = JSON.parse(readFileSync8(this.path, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.plans))
        return emptyFile();
      return {
        version: 1,
        plans: parsed.plans,
        updatedAt: parsed.updatedAt ?? new Date().toISOString()
      };
    } catch {
      return emptyFile();
    }
  }
  save(data) {
    atomicWriteJson3(this.path, { ...data, updatedAt: new Date().toISOString() }, 384);
  }
  get(provider, profile) {
    return this.load().plans.find((p) => p.provider === provider && p.profile === profile);
  }
  set(plan) {
    if (!Number.isFinite(plan.monthlyUsd) || plan.monthlyUsd < 0) {
      throw new Error("monthlyUsd must be a non-negative number");
    }
    const data = this.load();
    const idx = data.plans.findIndex((p) => p.provider === plan.provider && p.profile === plan.profile);
    const next = {
      provider: plan.provider,
      profile: plan.profile,
      monthlyUsd: plan.monthlyUsd,
      ...plan.planLabel ? { planLabel: plan.planLabel } : {},
      ...plan.billingCycleDay != null ? { billingCycleDay: plan.billingCycleDay } : {},
      ...plan.notes ? { notes: plan.notes } : {}
    };
    if (idx >= 0)
      data.plans[idx] = next;
    else
      data.plans.push(next);
    this.save(data);
    return next;
  }
  remove(provider, profile) {
    const data = this.load();
    const before = data.plans.length;
    data.plans = data.plans.filter((p) => !(p.provider === provider && p.profile === profile));
    if (data.plans.length === before)
      return false;
    this.save(data);
    return true;
  }
  list() {
    return [...this.load().plans].sort((a, b) => a.provider === b.provider ? a.profile.localeCompare(b.profile) : a.provider.localeCompare(b.provider));
  }
}

// src/usage/recommend.ts
function primaryWindow2(u) {
  if (!u?.ok || u.windows.length === 0) {
    return { remainingPercent: null, usedPercent: null, label: "-", resetsAt: null };
  }
  const ranked = [...u.windows].sort((a, b) => {
    const ar = a.remainingPercent ?? -1;
    const br = b.remainingPercent ?? -1;
    return br - ar;
  });
  const w = ranked.find((x) => x.remainingPercent != null) ?? ranked[0];
  return {
    remainingPercent: w.remainingPercent,
    usedPercent: w.usedPercent,
    label: w.label ?? w.kind,
    resetsAt: w.resetsAt
  };
}
function scoreAccount2(account, usage, preferred) {
  const win = primaryWindow2(usage);
  let score = 0;
  const notes = [];
  if (!isEligible(account)) {
    score = -1000;
    notes.push(account.availability === "QUOTA_EXHAUSTED" ? "0%/exhausted" : account.availability);
  } else {
    score += 100;
  }
  if (win.remainingPercent != null) {
    score += win.remainingPercent;
    if (win.remainingPercent <= 0) {
      score -= 500;
      notes.push("remote 0%");
    } else if (win.remainingPercent <= 5) {
      notes.push("low remaining");
    }
  } else if (usage && !usage.ok) {
    score += 10;
    notes.push(usage.error ? `usage err` : "no remote %");
  } else {
    score += 15;
    notes.push("no remote %");
  }
  if (preferred && account.profile === preferred && isEligible(account)) {
    score += 5;
    notes.push("preferred");
  }
  if (account.availability === "ACTIVE") {
    score += 2;
  }
  return {
    score,
    note: notes.join(", ") || "ok",
    remainingPercent: win.remainingPercent,
    usedPercent: win.usedPercent,
    label: win.label,
    resetsAt: win.resetsAt
  };
}
async function buildRecommendations2(store, opts) {
  const root = opts?.root ?? defaultOarRoot();
  let accounts = store.listAccounts();
  if (opts?.providers?.length) {
    const set = new Set(opts.providers);
    accounts = accounts.filter((a) => set.has(a.provider));
  }
  const targets = accounts.filter((a) => isXaiProvider2(a.provider) || isCodexProvider2(a.provider)).map((a) => ({ provider: a.provider, profile: a.profile }));
  const usageList = targets.length > 0 ? await fetchRemoteUsageForAccounts2(store, targets, {
    root,
    force: opts?.force ?? true,
    maxAgeMs: opts?.force ? 0 : 60000
  }) : [];
  const usageMap = new Map(usageList.map((u) => [`${u.provider}\x00${u.profile}`, u]));
  const preferredByProvider = new Map;
  for (const a of accounts) {
    if (!preferredByProvider.has(a.provider)) {
      preferredByProvider.set(a.provider, store.getProviderPolicy(a.provider).preferred);
    }
  }
  const scored = accounts.map((a) => {
    const u = usageMap.get(`${a.provider}\x00${a.profile}`);
    const preferred = preferredByProvider.get(a.provider);
    const s = scoreAccount2(a, u, preferred);
    const live = preferred === a.profile && a.availability === "ACTIVE";
    return {
      provider: a.provider,
      profile: a.profile,
      remainingPercent: s.remainingPercent,
      usedPercent: s.usedPercent,
      windowLabel: s.label,
      eligibility: isEligible(a) ? "ok" : a.availability,
      live,
      score: s.score,
      note: s.note,
      resetsAt: s.resetsAt
    };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score)
      return b.score - a.score;
    const ar = a.remainingPercent ?? -1;
    const br = b.remainingPercent ?? -1;
    if (br !== ar)
      return br - ar;
    return `${a.provider}/${a.profile}`.localeCompare(`${b.provider}/${b.profile}`);
  });
  return scored.map((row, i) => ({ ...row, rank: i + 1 }));
}
function fmtPct2(n) {
  if (n == null || !Number.isFinite(n))
    return "-";
  return `${n}%`;
}
function shortReset2(iso) {
  if (!iso)
    return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t))
    return "-";
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}
function formatRecommendTable(rows) {
  if (rows.length === 0)
    return `OAR recommend
(no accounts in vault)`;
  const top = rows.find((r) => r.score > 0 && r.eligibility === "ok");
  const table = formatMarkdownTable([
    { key: "rank", header: "RANK", align: "right" },
    { key: "provider", header: "PROVIDER" },
    { key: "profile", header: "PROFILE" },
    { key: "left", header: "LEFT", align: "right" },
    { key: "used", header: "USED", align: "right" },
    { key: "window", header: "WINDOW" },
    { key: "elig", header: "ELIG" },
    { key: "live", header: "LIVE" },
    { key: "score", header: "SCORE", align: "right" },
    { key: "reset", header: "RESET" },
    { key: "note", header: "NOTE" }
  ], rows.map((r) => ({
    rank: r.rank,
    provider: r.provider,
    profile: r.profile,
    left: fmtPct2(r.remainingPercent),
    used: fmtPct2(r.usedPercent),
    window: r.windowLabel,
    elig: r.eligibility,
    live: r.live ? "*" : "",
    score: Math.round(r.score),
    reset: shortReset2(r.resetsAt),
    note: r.note
  })));
  const lines = [
    "OAR recommend (higher rank = better to use next)",
    table,
    ""
  ];
  if (top) {
    lines.push(`top pick: ${top.provider}/${top.profile}` + (top.remainingPercent != null ? `  (${top.remainingPercent}% left)` : ""));
    lines.push(`switch:   oar use ${top.provider} ${top.profile}`);
  } else {
    lines.push("top pick: (none eligible — all exhausted or blocked)");
  }
  lines.push("");
  lines.push("Score = eligibility + remote remaining %. QUOTA_EXHAUSTED / 0% are ranked last and skipped by auto.");
  lines.push("This does not change the session model — only which account OAR would activate.");
  return lines.join(`
`);
}

// src/cli.ts
var __dirname2 = dirname5(fileURLToPath(import.meta.url));
function readPackageVersion() {
  const pkgPath = join8(__dirname2, "..", "package.json");
  if (!existsSync9(pkgPath))
    return "unknown";
  try {
    const parsed = JSON.parse(readFileSync9(pkgPath, "utf8"));
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
function usage() {
  return `oar \u2014 OMO Account Router

Local multi-account hot-switch for OMO/Senpi. OAR stores credentials in a vault,
copies the active profile into live auth.json slot(s), and tracks routing state.
OAR routes and copies credentials; it does NOT automate OAuth login and does NOT
revoke provider refresh tokens.

Tip: run \`oar\` with no args for status and freshly fetched remote usage.

STATUS TABLE (oar / oar status)
  AUTH     Local/vault metadata from import or last check (valid|expired|revoked|unknown).
           Can stay "valid" after the live access token expires until test/usage updates it.
  STATUS   Routing eligibility in the daemon (AVAILABLE, ACTIVE, QUOTA_EXHAUSTED, \u2026).
  ACTIVE   * marks the profile selected for that provider (target of the live auth slot).
  MODE     Provider policy: manual pick or auto failover.

  Separate from the status table:
  - \`oar usage\` OK column = latest remote usage API request succeeded (yes/no), not AUTH.
  - Routing STATUS and usage OK can disagree (e.g. AUTH valid but usage HTTP 401).

COMMANDS

  oar
      Quick status snapshot and freshly fetched remote usage when the daemon is up.
      On daemon failure, prints this help plus a start hint.

  oar status [--json]
      Markdown table: * PROVIDER PROFILE AUTH STATUS MODE AUTO NOTE.
      Header counts accounts / active / problematic. No remote usage fetch.
      --json  Structured rows + summary (exit 0).

  oar who
      Which vault profile is actually in each live auth.json. SLOT is set only
      when a Senpi accounts[] entry holds that same token. The footer @login-N
      is a per-session label and can name a different slot.

  oar accounts [provider]
      JSON list of vault accounts; optional filter by provider id.

  oar provider list
      One provider id per line from registered accounts.

  oar add <provider> <profile>
      Register a named profile slot (no credential yet).

  oar remove <provider> <profile>
      Delete that profile from daemon state and its vault credential.
      oar remove * deletes every vault account. Clears preferred if it
      pointed here. If the live auth.json slot is this same account, that
      provider key is removed. A different live account and subscription
      records stay.

  oar use <provider> <profile> [--force]
      Refreshes expired Codex/xAI OAuth in the vault without activating it,
      then checks remote usage and syncs quota state before switching.
      Refuses switch at 0% remaining unless --force. No OMO restart needed.
      Prints each sink id/status/path/detail (no credentials).

  oar auto <provider> on|off
      Enable/disable automatic failover to another eligible profile on failures.

  oar bootstrap-auto
      One-shot: for every provider with 2+ vault profiles, set mode=auto +
      autoFailover, and ensureActivated the preferred profile. OMO extension
      also runs this on session_start so daily use needs no manual oar.

  oar import-auth <provider> <profile> [--from <auth.json>] [--account <n|name>]
      Copy one provider credential from Senpi auth.json (default ~/.omo/agent/auth.json)
      into the OAR vault. openai, codex, chatgpt, and openai-codex all mean
      chatgpt-subscription. grok means xai. For chatgpt-subscription, --from may also be a native Codex
      auth.json (tokens.id_token + account_id; expiry from access-token JWT exp).
      When the provider slot carries a multi-login accounts[] array, --account
      selects one by 1-based index, name, latest, or primary. The default is
      latest (highest login-N). Pass --account or a third argument to override.
      Secrets stay in the vault; nothing is printed.

  oar import-auth --all [--from <auth.json>] [--profile <name>] [--force]
      Import every provider found in auth.json under one profile name (default main).
      Skips existing entries unless --force.

  oar login <provider> <profile>
      Print safe TUI login instructions only. OAuth stays in OMO/Senpi (/login);
      OAR never runs browser or device-code flows for you.

  oar logout <provider> <profile>
      Mark AUTH_REVOKED, remove vault entry. Does not restart Senpi.

  oar activate <provider> <profile>
      Low-level activate (JSON result); prefer \`oar use\` for hot-switch.

  oar test <provider> <profile> [--live]
      Probe stored credential. --live adds a best-effort remote call; does not
      change routing state.

  oar report <provider> <profile> <RESULT>
      Report runtime outcome to update STATUS (SUCCESS, AUTH_EXPIRED, AUTH_REVOKED,
      RATE_LIMITED, QUOTA_EXHAUSTED, NETWORK_ERROR, \u2026).

  oar guide second-account
      Step-by-step for logging in a second account without clobbering the live slot.

  oar install [-- <install.sh args>]
      Run scripts/install.sh (symlink oar, daemon setup). Pass extra args after --.

  oar panel [--watch [sec]] [--json] [--xbar] [--hours N] [--refresh] [--no-remote]
      Rich dashboard: accounts, events, remote usage (openai-codex / xai).
      --watch [sec]  Refresh loop (default 2s). --json / --xbar for machine output.
      --hours N      Event window (default 24). --refresh  Bypass usage cache.
      --no-remote    Skip remote usage fetches.

  oar usage [provider] [profile] [--refresh]
      Always fetch and show remote quota for openai-codex and xai (5H/WK/Grok %).
      OK = request ok. Omit args to list all supported accounts.

  oar recommend [--refresh] [--json] [provider...]
      Rank profiles by eligibility + remote remaining %. Optional provider filter.
      --refresh  Fetch fresh usage (default). Daemon must be running for full sync.
      --json     Structured rows + topPick (machine output).

  oar subscriptions list
      Show configured monthly plan costs (subscriptions.json under OAR_HOME).

  oar subscriptions set <provider> <profile> --monthly-usd <n> [--plan "label"]
      Record monthly subscription cost for a vault profile.

  oar subscriptions remove <provider> <profile>
      Remove a configured plan cost.

  oar subscriptions audit [--json] [--refresh]
      Join vault usage + eligibility + configured costs; suggest keep/cancel/fix
      and estimate potential monthly savings (heuristic, not financial advice).

  oar doctor
      Local diagnostics: paths, Senpi install, auth.json discovery, daemon JSON.

  oar daemon start|stop|status
      Background unix-socket daemon (required for most commands).
      start   Detach daemon.  stop   SIGTERM.  status   JSON doctor payload.

ENVIRONMENT
  OAR_HOME   State root and vault (default ~/.oar)
  OAR_SOCK   Unix socket path (default under OAR_HOME)
  Codex sink path: OAR_CODEX_AUTH_PATH > OAR_CODEX_HOME > CODEX_HOME > ~/.codex
  Argo sink path:  OAR_ARGO_SECRETS_PATH or ~/Library/Application Support/com.beyondworks.argo/...
  Disable sinks:   OAR_SINKS=0 / OAR_ARGO_SINK=0 / OAR_CODEX_SINK=0 (restart daemon)

OAUTH TROUBLESHOOTING
  Symptoms: Senpi \`invalid_grant\`, refresh token revoked, HTTP 401/403 on usage or
  --live test, or AUTH/usage OK out of sync after long idle / reboot.

  v0.1.5+: resolve/ensureActivated pulls vault UP from a fresher live OAuth token
  (Senpi refresh) instead of overwriting live with a stale vault copy. Explicit
  \`oar use\` still pushes the preferred vault profile into the live slot.

  If refresh is already revoked at the provider, re-authenticate:

    1. oar login <provider> <profile>     # read the steps
    2. omo  \u2192  /login  \u2192  pick provider  \u2192  complete browser OAuth
    3. oar import-auth <provider> <profile>
    4. oar use <provider> <profile>
    5. oar test <provider> <profile> --live
       oar usage <provider> <profile> --refresh

  Second account on same provider: oar guide second-account

EXAMPLES
  oar daemon start
  oar import-auth --all
  oar status
  oar use xai main
  oar panel --refresh
  oar usage --refresh
  oar recommend xai openai-codex
  oar auto xai on
`;
}
function secondAccountGuide() {
  return `Second account login guide (see also scripts/second-account.md)
\uB450 \uBC88\uC9F8 \uACC4\uC815 \uB85C\uADF8\uC778 \uAC00\uC774\uB4DC (scripts/second-account.md \uCC38\uACE0)

IMPORTANT: the \`omo\` launcher ALWAYS forces SENPI_CODING_AGENT_DIR=~/.omo/agent.
Do NOT use \`omo\` for an isolated second login \u2014 it will overwrite the live slot.
\uC911\uC694: \`omo\` \uB7F0\uCC98\uB294 \uD56D\uC0C1 SENPI_CODING_AGENT_DIR=~/.omo/agent \uB85C \uACE0\uC815\uD569\uB2C8\uB2E4.
\uB450 \uBC88\uC9F8 \uACC4\uC815 \uACA9\uB9AC \uB85C\uADF8\uC778\uC5D0\uB294 \`omo\` \uB97C \uC4F0\uC9C0 \uB9C8\uC138\uC694 (\uB77C\uC774\uBE0C \uC2AC\uB86F\uC744 \uB36E\uC5B4\uC501\uB2C8\uB2E4).

Method A \u2014 isolated senpi dir (recommended):
  1. oar import-auth <provider> main   # vault the current live account first
  2. export OAR_TMP_LOGIN_DIR="$(mktemp -d)/agent" && mkdir -p "$OAR_TMP_LOGIN_DIR"
  3. SENPI_CODING_AGENT_DIR="$OAR_TMP_LOGIN_DIR" senpi
     # inside TUI: /login  \u2192 pick provider \u2192 browser OAuth as SECOND account
  4. oar import-auth <provider> account-b --from "$OAR_TMP_LOGIN_DIR/auth.json"
  5. rm -rf "$(dirname "$OAR_TMP_LOGIN_DIR")"
  6. oar use <provider> account-b && oar status

Method B \u2014 temporary live swap (if senpi binary unavailable):
  1. oar import-auth <provider> main
  2. omo  \u2192  /logout <provider>  \u2192  /login <provider>  (second account)
  3. oar import-auth <provider> account-b
  4. oar use <provider> main     # restore first account into the live slot

No OMO restart needed after oar use \u2014 next request picks up the new slot.
oar use \uC774\uD6C4 OMO \uC7AC\uC2DC\uC791 \uBD88\uD544\uC694 \u2014 \uB2E4\uC74C \uC694\uCCAD\uBD80\uD130 \uC0C8 \uC2AC\uB86F \uC0AC\uC6A9.`;
}
async function withClient(fn) {
  const client = new OarClient({
    socketPath: process.env.OAR_SOCK ?? oarSocketPath2(),
    retries: 8
  });
  try {
    return await fn(client);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ENOENT") || msg.includes("ECONNREFUSED")) {
      throw new Error(`OAR daemon unavailable (${process.env.OAR_SOCK ?? oarSocketPath2()}). Run: oar daemon start`);
    }
    throw error;
  }
}
async function req(request) {
  return withClient((c) => c.request(request));
}
async function removeOne(provider, profile) {
  const res = await req({ protocol: 1, action: "remove", provider, profile });
  if (!res.ok)
    throw new Error(res.error);
  console.log(`removed ${provider}/${profile}`);
  const data = res.data;
  for (const path of data.authSlotsCleared ?? [])
    console.log(`auth slot cleared: ${path}`);
  for (const path of data.authSlotsKept ?? []) {
    console.log(`auth slot kept: ${path} (different account)`);
  }
}
async function warnIfDaemonDown(scope) {
  try {
    const res = await req({ protocol: 1, action: "ping" });
    return res.ok;
  } catch {
    console.error(`warning: OAR daemon unavailable \u2014 ${scope} uses cached/local vault data only (may be stale). Run: oar daemon start`);
    return false;
  }
}
function printStatus(data, opts) {
  const root = process.env.OAR_HOME ?? defaultOarRoot2();
  const store = new OarStore({ rootDir: root });
  let view = buildStatusView(data);
  view = { ...view, rows: applyAuthStaleHints(view.rows, store) };
  if (opts?.json) {
    console.log(JSON.stringify(statusViewToJson(view), null, 2));
    return;
  }
  console.log(formatStatusText(view, { color: wantStatusColor() }));
}
async function daemonStart() {
  const root = process.env.OAR_HOME ?? defaultOarRoot2();
  const sock = process.env.OAR_SOCK ?? oarSocketPath2(root);
  if (existsSync9(sock)) {
    try {
      const client = new OarClient({ socketPath: sock });
      const pong = await client.request({ protocol: 1, action: "ping" });
      if (pong.ok) {
        console.log(`oar-daemon already running at ${sock}`);
        return;
      }
    } catch {}
  }
  const daemonTs = join8(__dirname2, "daemon-main.ts");
  const daemonJs = join8(__dirname2, "daemon-main.js");
  const daemonEntry = existsSync9(daemonTs) ? daemonTs : daemonJs;
  const runtimeBin = typeof process.execPath === "string" && process.execPath.length > 0 ? process.execPath : "node";
  const useBunForTs = daemonEntry.endsWith(".ts") && !runtimeBin.includes("bun");
  const spawnBin = useBunForTs ? "bun" : runtimeBin;
  const spawnArgs = useBunForTs ? [daemonEntry] : [daemonEntry];
  const child = spawn(spawnBin, spawnArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OAR_HOME: root, OAR_SOCK: sock }
  });
  child.unref();
  const ready = new OarClient({ socketPath: sock, retries: 20, timeoutMs: 500 });
  try {
    const pong = await ready.request({ protocol: 1, action: "ping" });
    if (pong.ok) {
      console.log(`oar-daemon started at ${sock}`);
      return;
    }
  } catch {}
  throw new Error("oar-daemon failed to become ready");
}
async function daemonStop() {
  const sock = process.env.OAR_SOCK ?? oarSocketPath2();
  const pidPath = `${sock}.pid`;
  if (!existsSync9(pidPath)) {
    console.log("oar-daemon not running (no pid file)");
    return;
  }
  const pid = Number(readFileSync9(pidPath, "utf8").trim());
  if (!Number.isFinite(pid))
    throw new Error("invalid pid file");
  try {
    process.kill(pid, "SIGTERM");
    console.log(`sent SIGTERM to oar-daemon pid ${pid}`);
  } catch (error) {
    console.log(`could not signal pid ${pid}: ${error instanceof Error ? error.message : error}`);
  }
}
async function daemonStatus() {
  try {
    const res = await req({ protocol: 1, action: "doctor" });
    console.log(JSON.stringify(res, null, 2));
  } catch (error) {
    console.log(`oar-daemon down: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
function suggestAccounts(provider) {
  try {} catch {}
  return provider ? `Try: oar accounts ${provider}   or   oar import-auth ${provider} <profile>` : `Try: oar accounts   or   oar import-auth --all`;
}
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "-h" || cmd === "--help") {
    console.log(usage());
    return;
  }
  if (cmd === "--version" || cmd === "-V") {
    console.log(readPackageVersion());
    return;
  }
  if (cmd === "help") {
    console.log(usage());
    return;
  }
  if (!cmd) {
    try {
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok)
        throw new Error(res.error);
      const data = res.data;
      printStatus(data);
      const root = process.env.OAR_HOME ?? defaultOarRoot2();
      const store = new OarStore({ rootDir: root });
      const targets = data.accounts.filter((account) => isCodexProvider(account.provider) || isXaiProvider(account.provider)).map((account) => ({ provider: account.provider, profile: account.profile }));
      if (targets.length > 0) {
        const rows = await fetchRemoteUsageForAccounts(store, targets, { root, force: true });
        console.log("");
        console.log(formatUsageTable(rows));
      }
    } catch (error) {
      console.log(usage());
      console.error(`
(daemon tip: ${error instanceof Error ? error.message : error})`);
      console.error("Start with: oar daemon start");
      process.exitCode = 1;
    }
    return;
  }
  switch (cmd) {
    case "status": {
      rejectUnknownFlags(rest, new Set(["--json"]));
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok)
        throw new Error(res.error);
      printStatus(res.data, { json: rest.includes("--json") });
      return;
    }
    case "who": {
      const root = process.env.OAR_HOME ?? defaultOarRoot2();
      const store = new OarStore({ rootDir: root });
      const rows = describeLiveAuth(resolveActiveAuthPaths2(), store.listAccounts(), (provider, profile) => store.getVaultCredential(provider, profile));
      console.log(formatWho(rows));
      return;
    }
    case "accounts": {
      const res = await req({ protocol: 1, action: "accounts", provider: rest[0] });
      if (!res.ok)
        throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      return;
    }
    case "provider": {
      if (rest[0] !== "list")
        throw new Error("usage: oar provider list");
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok)
        throw new Error(res.error);
      const accounts = res.data.accounts;
      const providers = [...new Set(accounts.map((a) => a.provider))];
      console.log(providers.join(`
`) || "(no providers)");
      return;
    }
    case "add": {
      const [provider, profile] = rest;
      if (!provider || !profile)
        throw new Error("usage: oar add <provider> <profile>");
      const res = await req({ protocol: 1, action: "add", provider, profile });
      if (!res.ok)
        throw new Error(res.error);
      console.log(`added ${provider}/${profile}`);
      return;
    }
    case "remove": {
      if (rest[0] === "*") {
        const listed = await req({ protocol: 1, action: "accounts" });
        if (!listed.ok)
          throw new Error(listed.error);
        const accounts = listed.data;
        if (accounts.length === 0) {
          console.log("removed 0 accounts");
          return;
        }
        for (const account of accounts) {
          await removeOne(account.provider, account.profile);
        }
        console.log(`removed ${accounts.length} accounts`);
        return;
      }
      const [provider, profile] = rest;
      if (!provider || !profile)
        throw new Error(`usage: oar remove <provider> <profile>
   or: oar remove *`);
      await removeOne(provider, profile);
      return;
    }
    case "use": {
      rejectUnknownFlags(rest, new Set(["--force"]));
      const force = rest.includes("--force");
      const [provider, profile] = positionalArgs(rest);
      if (!provider || !profile) {
        throw new Error(`usage: oar use <provider> <profile> [--force]
` + suggestAccounts());
      }
      const root = process.env.OAR_HOME ?? defaultOarRoot2();
      const store = new OarStore({ rootDir: root });
      const credential = store.getVaultCredential(provider, profile);
      if ((isCodexProvider(provider) || isXaiProvider(provider)) && credential?.type === "oauth" && Date.now() + 5 * 60 * 1000 >= credential.expires) {
        const refreshed = await req({
          protocol: 1,
          action: "refresh",
          provider,
          profile,
          activate: false
        });
        if (!refreshed.ok) {
          throw new Error(`REFUSED: could not refresh ${provider}/${profile} before checking quota: ${refreshed.error}`);
        }
      }
      try {
        const u = await fetchRemoteUsage(store, provider, profile, {
          root,
          force: true,
          maxAgeMs: 0
        });
        if (u.ok) {
          const w = u.windows.find((x) => x.remainingPercent != null) ?? u.windows[0];
          if (w?.remainingPercent != null && (w.remainingPercent <= 0 || w.limitReached)) {
            console.error(`WARNING: ${provider}/${profile} remote quota is exhausted (${w.remainingPercent}% remaining, ${w.label ?? w.kind}).`);
            if (w.resetsAt)
              console.error(`  resets ~ ${w.resetsAt}`);
            try {
              await req({
                protocol: 1,
                action: "report",
                provider,
                account: profile,
                result: "QUOTA_EXHAUSTED",
                detail: `remote_usage_${w.label ?? w.kind}_0`
              });
            } catch {}
            if (!force) {
              throw new Error(`REFUSED: not switching to ${provider}/${profile}; remote quota is exhausted ` + `(${w.remainingPercent}% remaining). ` + `Auto failover will also skip it. Use another profile, or --force to override.`);
            }
            console.error("  --force set: switching anyway.");
          } else if (w?.remainingPercent != null) {
            try {
              const reported = await req({
                protocol: 1,
                action: "report",
                provider,
                account: profile,
                result: "QUOTA_AVAILABLE"
              });
              if (!reported.ok)
                throw new Error(reported.error);
            } catch (error) {
              throw new Error(`REFUSED: could not sync current quota for ${provider}/${profile}: ${error instanceof Error ? error.message : error}`);
            }
            if (w.remainingPercent <= 5) {
              console.log(`warning: remote remaining ~${w.remainingPercent}% (${w.label ?? w.kind}).`);
            }
          }
        } else if (/\bHTTP 401\b/.test(u.error ?? "")) {
          try {
            const reported = await req({
              protocol: 1,
              action: "report",
              provider,
              account: profile,
              result: "AUTH_EXPIRED",
              detail: "remote_usage_http_401"
            });
            if (!reported.ok)
              throw new Error(reported.error);
          } catch (error) {
            throw new Error(`REFUSED: usage authentication failed for ${provider}/${profile} (HTTP 401); state update failed: ${error instanceof Error ? error.message : error}`);
          }
          throw new Error(`REFUSED: usage authentication failed for ${provider}/${profile} (HTTP 401). Refresh or re-login, then try again.`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("REFUSED:"))
          throw error;
      }
      const res = await req({ protocol: 1, action: "use", provider, profile, force });
      if (!res.ok) {
        const err = res.error || "use failed";
        if (/unknown account/i.test(err)) {
          throw new Error(`${err}
${suggestAccounts(provider)}`);
        }
        throw new Error(err);
      }
      const data = res.data;
      console.log(data.message ?? `now using ${provider}/${data.profile ?? profile}`);
      if (data.activatedPaths?.length) {
        console.log(`auth slot: ${data.activatedPaths.join(", ")}`);
      }
      for (const line of formatSinkResultLines(Array.isArray(data.sinks) ? data.sinks : [])) {
        console.log(line);
      }
      return;
    }
    case "auto": {
      const [provider, onoff] = rest;
      if (!provider || onoff !== "on" && onoff !== "off") {
        throw new Error("usage: oar auto <provider> on|off");
      }
      const res = await req({ protocol: 1, action: "auto", provider, enabled: onoff === "on" });
      if (!res.ok)
        throw new Error(res.error);
      console.log(JSON.stringify(res.data));
      return;
    }
    case "import-auth": {
      if (rest.includes("--all")) {
        rejectUnknownFlags(rest, new Set(["--all", "--from", "--force", "--profile"]), new Set(["--from", "--profile"]));
      } else {
        rejectUnknownFlags(rest, new Set(["--from", "--account"]), new Set(["--from", "--account"]));
      }
      let from = join8(homedir4(), ".omo", "agent", "auth.json");
      const fromIdx = rest.indexOf("--from");
      if (fromIdx >= 0 && rest[fromIdx + 1])
        from = rest[fromIdx + 1];
      if (rest.includes("--all")) {
        let profile2 = "main";
        const profileIdx = rest.indexOf("--profile");
        if (profileIdx >= 0 && rest[profileIdx + 1])
          profile2 = rest[profileIdx + 1];
        const force = rest.includes("--force");
        const result = await withClient((c) => importAllFromAuthJson(c, { from, profile: profile2, force }));
        for (const provider2 of result.imported)
          console.log(`imported ${provider2}/${profile2}`);
        for (const provider2 of result.skipped) {
          console.log(`skipped ${provider2}/${profile2} (already in vault; use --force to overwrite)`);
        }
        for (const { provider: provider2, error } of result.errors)
          console.log(`failed ${provider2}/${profile2}: ${error}`);
        console.log(`import-auth --all: ${result.imported.length} imported, ${result.skipped.length} skipped, ${result.errors.length} failed (from ${from}; secrets stored under OAR vault, not logged)`);
        if (result.errors.length > 0)
          process.exitCode = 1;
        return;
      }
      if (rest[0] === "default") {
        const value = rest[1];
        if (!value) {
          console.log(readImportAccountSetting());
          return;
        }
        writeImportAccountSetting(value);
        console.log(`import account default: ${value}`);
        return;
      }
      const [provider, profile] = positionalArgs(rest, new Set(["--from", "--account"]));
      if (!provider || !profile) {
        throw new Error(`usage: oar import-auth <provider> <profile> [--from path] [--account <n|name|latest>]
   or: oar import-auth default [primary|latest|<slot>]
   or: oar import-auth --all [--from path] [--profile name] [--force]`);
      }
      const accountIdx = rest.indexOf("--account");
      const flagged = accountIdx >= 0 ? rest[accountIdx + 1] : undefined;
      const positional = positionalArgs(rest, new Set(["--from", "--account"]));
      const extra = positional[2];
      const account = flagged ?? extra ?? readImportAccountSetting();
      const credential = readCredentialFromAuthJson(from, provider, { account });
      const used = importSelectionUsed(from, provider, account);
      const res = await req({
        protocol: 1,
        action: "import-credential",
        provider,
        profile,
        credential
      });
      if (!res.ok)
        throw new Error(res.error);
      console.log(`imported ${provider}/${profile} from ${from} using ${used} (secrets stored under OAR vault, not logged)`);
      return;
    }
    case "login": {
      const [provider, profile] = rest;
      if (!provider || !profile)
        throw new Error("usage: oar login <provider> <profile>");
      console.log([
        `Interactive provider login stays in OMO/Senpi (device-code / OAuth) \u2014 OAR never automates it.`,
        `There is no \`omo auth login\` subcommand. Use the TUI \`/login\` command.`,
        ``,
        `First account (normal live agent dir ~/.omo/agent):`,
        `  1. omo`,
        `  2. /login  \u2192 select ${provider} \u2192 complete browser/device OAuth`,
        `  3. oar import-auth ${provider} ${profile}`,
        `  4. oar use ${provider} ${profile}`,
        ``,
        `Adding a SECOND account for the same provider:`,
        `  oar guide second-account`,
        ``,
        `Do not paste tokens into the shell.`
      ].join(`
`));
      return;
    }
    case "guide": {
      if (rest[0] !== "second-account")
        throw new Error("usage: oar guide second-account");
      console.log(secondAccountGuide());
      return;
    }
    case "install": {
      const scriptPath = join8(__dirname2, "..", "scripts", "install.sh");
      if (!existsSync9(scriptPath)) {
        throw new Error(`install script not found at ${scriptPath}. Run scripts/install.sh directly from a full checkout.`);
      }
      const result = spawnSync(scriptPath, rest, { stdio: "inherit" });
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
      }
      return;
    }
    case "logout": {
      const [provider, profile] = rest;
      if (!provider || !profile)
        throw new Error("usage: oar logout <provider> <profile>");
      const reported = await req({
        protocol: 1,
        action: "report",
        provider,
        account: profile,
        result: "AUTH_REVOKED",
        detail: "logout"
      });
      if (!reported.ok)
        throw new Error(reported.error);
      const res = await req({ protocol: 1, action: "remove", provider, profile });
      if (!res.ok)
        throw new Error(res.error);
      console.log(`logged out ${provider}/${profile} (vault removed; Senpi session not restarted)`);
      return;
    }
    case "activate": {
      const [provider, profile] = rest;
      if (!provider || !profile)
        throw new Error("usage: oar activate <provider> <profile>");
      const res = await req({ protocol: 1, action: "activate", provider, profile });
      if (!res.ok)
        throw new Error(res.error);
      console.log(JSON.stringify(res.data));
      return;
    }
    case "test": {
      rejectUnknownFlags(rest, new Set(["--live"]));
      const [provider, profile] = positionalArgs(rest);
      if (!provider || !profile)
        throw new Error("usage: oar test <provider> <profile> [--live]");
      const live = rest.includes("--live");
      const res = await req({ protocol: 1, action: "test", provider, profile, live });
      if (!res.ok)
        throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      if (live) {
        console.log("(--live is a best-effort connectivity probe; it does not update routing state \u2014 see README design limits)");
      }
      return;
    }
    case "report": {
      const [provider, profile, result] = rest;
      if (!provider || !profile || !result)
        throw new Error("usage: oar report <provider> <profile> <RESULT>");
      parseReportResult(result);
      const res = await req({
        protocol: 1,
        action: "report",
        provider,
        account: profile,
        result
      });
      if (!res.ok)
        throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      return;
    }
    case "panel": {
      rejectUnknownFlags(rest, new Set(["--watch", "--json", "--xbar", "--hours", "--refresh", "--no-remote"]), new Set(["--hours"]));
      const watchIdx = rest.indexOf("--watch");
      const json = rest.includes("--json");
      const xbar = rest.includes("--xbar");
      const refresh = rest.includes("--refresh");
      const noRemote = rest.includes("--no-remote");
      let hours = 24;
      const hoursIdx = rest.indexOf("--hours");
      if (hoursIdx >= 0 && rest[hoursIdx + 1]) {
        hours = Number(rest[hoursIdx + 1]);
        if (!Number.isFinite(hours) || hours <= 0)
          throw new Error("--hours must be a positive number");
      }
      let intervalSec = 0;
      if (watchIdx >= 0) {
        const maybe = rest[watchIdx + 1];
        intervalSec = maybe && !maybe.startsWith("--") ? Number(maybe) : 2;
        if (!Number.isFinite(intervalSec) || intervalSec <= 0)
          intervalSec = 2;
      }
      const root = process.env.OAR_HOME ?? defaultOarRoot2();
      const store = new OarStore({ rootDir: root });
      const renderOnce = async () => {
        const res = await req({ protocol: 1, action: "status" });
        if (!res.ok)
          throw new Error(res.error);
        const status = res.data;
        let remoteUsage = undefined;
        if (!noRemote) {
          const targets = (status.accounts ?? []).filter((a) => isCodexProvider(a.provider) || isXaiProvider(a.provider)).map((a) => ({ provider: a.provider, profile: a.profile }));
          remoteUsage = await fetchRemoteUsageForAccounts(store, targets, {
            root,
            force: refresh,
            maxAgeMs: refresh ? 0 : 60000
          });
        }
        const snap = buildPanelSnapshot(status, {
          windowHours: hours,
          rootDir: root,
          remoteUsage
        });
        if (json)
          console.log(JSON.stringify(snap, null, 2));
        else if (xbar)
          console.log(formatPanelXbar(snap));
        else
          console.log(formatPanelText(snap));
      };
      if (intervalSec > 0 && !json && !xbar) {
        for (;; ) {
          process.stdout.write("\x1B[2J\x1B[H");
          await renderOnce();
          console.log(`
watching every ${intervalSec}s  \xB7  Ctrl+C to stop`);
          await new Promise((r) => setTimeout(r, intervalSec * 1000));
        }
      } else {
        await renderOnce();
      }
      return;
    }
    case "usage": {
      rejectUnknownFlags(rest, new Set(["--refresh"]));
      await warnIfDaemonDown("usage");
      const args = rest.filter((a) => !a.startsWith("--"));
      const root = process.env.OAR_HOME ?? defaultOarRoot2();
      const store = new OarStore({ rootDir: root });
      const provider = args[0];
      const profile = args[1];
      const targets = provider && profile ? [{ provider, profile }] : store.listAccounts().filter((a) => isCodexProvider(a.provider) || isXaiProvider(a.provider)).map((a) => ({ provider: a.provider, profile: a.profile }));
      if (targets.length === 0) {
        console.log("no openai-codex / xai accounts in vault");
        return;
      }
      const rows = await fetchRemoteUsageForAccounts(store, targets, {
        root,
        force: true
      });
      rows.sort((a, b) => a.provider === b.provider ? a.profile.localeCompare(b.profile) : a.provider.localeCompare(b.provider));
      for (const u of rows) {
        if (!u.ok)
          continue;
        const primary = u.windows.find((w) => w.remainingPercent != null) ?? u.windows[0];
        if (!primary || primary.remainingPercent == null)
          continue;
        if (primary.remainingPercent <= 0 || primary.limitReached) {
          try {
            await req({
              protocol: 1,
              action: "report",
              provider: u.provider,
              account: u.profile,
              result: "QUOTA_EXHAUSTED",
              detail: `remote_usage_${primary.label ?? primary.kind}_0`
            });
          } catch {}
        }
      }
      console.log(formatUsageTable(rows));
      return;
    }
    case "recommend":
    case "recommand": {
      rejectUnknownFlags(rest, new Set(["--refresh", "--cache", "--json"]));
      await warnIfDaemonDown("recommend");
      const json = rest.includes("--json");
      const refresh = rest.includes("--refresh") || !rest.includes("--cache");
      const providers = positionalArgs(rest);
      const root = process.env.OAR_HOME ?? defaultOarRoot2();
      const store = new OarStore({ rootDir: root });
      try {
        const st = await req({ protocol: 1, action: "accounts" });
        if (st.ok && Array.isArray(st.data)) {}
      } catch {}
      const rows = await buildRecommendations2(store, {
        root,
        force: refresh,
        providers: providers.length ? providers : undefined
      });
      for (const r of rows) {
        if (r.remainingPercent != null && r.remainingPercent <= 0) {
          try {
            await req({
              protocol: 1,
              action: "report",
              provider: r.provider,
              account: r.profile,
              result: "QUOTA_EXHAUSTED",
              detail: "recommend_remote_0"
            });
          } catch {}
        }
      }
      if (json) {
        const top = rows.find((r) => r.score > 0 && r.eligibility === "ok");
        console.log(JSON.stringify({
          generatedAt: new Date().toISOString(),
          topPick: top ? { provider: top.provider, profile: top.profile } : null,
          rows
        }, null, 2));
      } else {
        console.log(formatRecommendTable(rows));
      }
      return;
    }
    case "bootstrap-auto": {
      const res = await req({ protocol: 1, action: "bootstrap-auto" });
      if (!res.ok)
        throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      return;
    }
    case "subscriptions": {
      const sub = rest[0];
      const root = process.env.OAR_HOME ?? defaultOarRoot2();
      const subsStore = new SubscriptionsStore({ rootDir: root });
      const oarStore = new OarStore({ rootDir: root });
      if (sub === "list") {
        rejectUnknownFlags(rest.slice(1), new Set([]));
        console.log(formatSubscriptionsList(subsStore.list()));
        return;
      }
      if (sub === "set") {
        const valueFlags = new Set(["--monthly-usd", "--plan", "--billing-cycle-day", "--notes"]);
        rejectUnknownFlags(rest.slice(1), valueFlags, valueFlags);
        const [provider, profile] = positionalArgs(rest.slice(1), valueFlags);
        if (!provider || !profile) {
          throw new Error('usage: oar subscriptions set <provider> <profile> --monthly-usd <n> [--plan "label"] [--billing-cycle-day N]');
        }
        const usdIdx = rest.indexOf("--monthly-usd");
        if (usdIdx < 0 || !rest[usdIdx + 1]) {
          throw new Error("--monthly-usd is required and must be a non-negative number");
        }
        const monthlyUsd = Number(rest[usdIdx + 1]);
        let planLabel;
        const planIdx = rest.indexOf("--plan");
        if (planIdx >= 0 && rest[planIdx + 1])
          planLabel = rest[planIdx + 1];
        let billingCycleDay;
        const cycleIdx = rest.indexOf("--billing-cycle-day");
        if (cycleIdx >= 0 && rest[cycleIdx + 1]) {
          billingCycleDay = Number(rest[cycleIdx + 1]);
          if (!Number.isFinite(billingCycleDay) || billingCycleDay < 1 || billingCycleDay > 31) {
            throw new Error("--billing-cycle-day must be 1\u201331");
          }
        }
        let notes;
        const notesIdx = rest.indexOf("--notes");
        if (notesIdx >= 0 && rest[notesIdx + 1])
          notes = rest[notesIdx + 1];
        const saved = subsStore.set({
          provider,
          profile,
          monthlyUsd,
          ...planLabel ? { planLabel } : {},
          ...billingCycleDay != null ? { billingCycleDay } : {},
          ...notes ? { notes } : {}
        });
        console.log(`saved ${saved.provider}/${saved.profile} ${saved.planLabel ?? "plan"} @ $${saved.monthlyUsd}/mo`);
        return;
      }
      if (sub === "remove") {
        rejectUnknownFlags(rest.slice(1), new Set([]));
        const [provider, profile] = rest.slice(1);
        if (!provider || !profile) {
          throw new Error("usage: oar subscriptions remove <provider> <profile>");
        }
        if (!subsStore.remove(provider, profile)) {
          throw new Error(`unknown subscription plan: ${provider}/${profile}`);
        }
        console.log(`removed subscription plan ${provider}/${profile}`);
        return;
      }
      if (sub === "audit") {
        rejectUnknownFlags(rest.slice(1), new Set(["--json", "--refresh"]));
        await warnIfDaemonDown("subscriptions audit");
        const json = rest.includes("--json");
        const refresh = rest.includes("--refresh");
        const result = await buildSubscriptionAudit(oarStore, subsStore, { root, force: refresh });
        if (json)
          console.log(JSON.stringify(auditToJson(result), null, 2));
        else
          console.log(formatAuditText(result));
        return;
      }
      throw new Error(`usage: oar subscriptions list|set|remove|audit
` + '  oar subscriptions set <provider> <profile> --monthly-usd <n> [--plan "label"]');
    }
    case "doctor": {
      console.log("OAR doctor");
      console.log(`root: ${process.env.OAR_HOME ?? defaultOarRoot2()}`);
      console.log(`sock: ${process.env.OAR_SOCK ?? oarSocketPath2()}`);
      const install = findSenpiInstall2();
      if (install) {
        console.log(`omo-ai: ${install.omoAiVersion}`);
        console.log(`senpi:  ${install.senpiVersion}`);
        console.log(`engine: ${install.senpiRoot}`);
      } else {
        console.log("omo-ai/senpi install: not found");
      }
      console.log("active auth paths:");
      for (const p of resolveActiveAuthPaths2()) {
        console.log(`  ${existsSync9(p) ? "OK" : "--"} ${p}`);
      }
      console.log("discovered auth.json:");
      for (const p of discoverAuthJsonFiles()) {
        console.log(`  ${p}`);
      }
      await daemonStatus();
      const root = process.env.OAR_HOME ?? defaultOarRoot2();
      const store = new OarStore({ rootDir: root });
      const codexAccounts = store.listAccounts().filter((a) => isCodexProvider(a.provider)).map((a) => ({ provider: a.provider, profile: a.profile }));
      if (codexAccounts.length > 0) {
        const usageRows = await fetchRemoteUsageForAccounts(store, codexAccounts, {
          root,
          force: false,
          maxAgeMs: 300000
        });
        const authFailures = usageRows.filter((u) => !u.ok && /401|403|invalid_grant/i.test(u.error ?? ""));
        if (authFailures.length > 0) {
          console.log("");
          console.log("codex usage auth issue detected:");
          for (const u of authFailures) {
            console.log(`  ${u.provider}/${u.profile}: ${u.error ?? "HTTP auth error"}`);
          }
          console.log("  remediation:");
          console.log("    1. oar login openai-codex <profile>");
          console.log("    2. omo \u2192 /login \u2192 openai-codex \u2192 complete OAuth");
          console.log("    3. oar import-auth openai-codex <profile>");
          console.log("    4. oar test openai-codex <profile> --live");
          console.log("    5. oar usage openai-codex <profile> --refresh");
        }
      }
      console.log("");
      console.log("tips:");
      console.log("  oar panel --refresh   # accounts + remaining %");
      console.log("  oar usage --refresh   # Codex WK/5H + Grok %");
      console.log("  oar use <p> <profile> # hot-switch live slot");
      console.log("  oar bootstrap-auto   # enable multi-profile auto failover");
      console.log("  bash scripts/bootstrap-omo-oar.sh  # OMO+Cursor wire-up");
      return;
    }
    case "daemon": {
      const sub = rest[0];
      if (sub === "start")
        return daemonStart();
      if (sub === "stop")
        return daemonStop();
      if (sub === "status")
        return daemonStatus();
      throw new Error("usage: oar daemon start|stop|status");
    }
    default:
      throw new Error(`unknown command: ${cmd} (try: oar -h)`);
  }
}
main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
