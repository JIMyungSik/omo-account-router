#!/usr/bin/env node
// @bun

// src/cli.ts
import { spawn, spawnSync } from "child_process";
import { existsSync as existsSync6, readFileSync as readFileSync6 } from "fs";
import { homedir as homedir4 } from "os";
import { dirname as dirname4, join as join6 } from "path";
import { fileURLToPath } from "url";

// src/client.ts
import { createConnection } from "node:net";

// src/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function defaultOarRoot2(env = process.env) {
  if (env.OAR_HOME)
    return env.OAR_HOME;
  return join(homedir(), ".oar");
}
function oarSocketPath(root = defaultOarRoot2()) {
  return join(root, "oar.sock");
}
function oarStatePath(root = defaultOarRoot2()) {
  return join(root, "state.json");
}
function oarVaultDir(root = defaultOarRoot2()) {
  return join(root, "vault");
}
function oarEventsPath(root = defaultOarRoot2()) {
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

// src/import-all.ts
import { readFileSync } from "node:fs";
function isStoredCredential(value) {
  if (!value || typeof value !== "object")
    return false;
  const v = value;
  if (v.type === "oauth") {
    return typeof v.access === "string" && typeof v.refresh === "string" && typeof v.expires === "number";
  }
  if (v.type === "api_key") {
    return typeof v.key === "string";
  }
  return false;
}
function readAllCredentialsFromAuthJson(authPath) {
  const raw = readFileSync(authPath, "utf8");
  const data = JSON.parse(raw);
  const out = {};
  for (const [provider, value] of Object.entries(data)) {
    if (isStoredCredential(value)) {
      out[provider] = value;
    }
  }
  return out;
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

// src/paths.ts
import { existsSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function defaultOarRoot3(env = process.env) {
  if (env.OAR_HOME)
    return env.OAR_HOME;
  return join2(homedir2(), ".oar");
}
function oarSocketPath2(root = defaultOarRoot3()) {
  return join2(root, "oar.sock");
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
    const existing = known.filter((p) => existsSync(p));
    return existing.length > 0 ? existing : [known[0]];
  }
  const omoAgent = join2(home, ".omo", "agent", "auth.json");
  if (existsSync(omoAgent) || existsSync(join2(home, ".omo")))
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
function discoverAuthJsonFiles(env = process.env, home = homedir2()) {
  return unique([...resolveActiveAuthPaths(env, home), ...knownAuthJsonCandidates(home)]).filter((p) => existsSync(p));
}

// src/senpi-install.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { createRequire } from "node:module";
import { homedir as homedir3 } from "node:os";
import { dirname, join as join3 } from "node:path";
var KNOWN_OMO = "/opt/homebrew/lib/node_modules/omo-ai";
function readJson(path) {
  return JSON.parse(readFileSync2(path, "utf8"));
}
function fromOmoRoot(omoRoot) {
  const omoPkg = join3(omoRoot, "package.json");
  const senpiRoot = join3(omoRoot, "node_modules", "@code-yeongyu", "senpi");
  const senpiPkg = join3(senpiRoot, "package.json");
  const authStoragePath = join3(senpiRoot, "dist", "core", "auth-storage.js");
  const pluginRoot = join3(omoRoot, "plugin");
  if (!existsSync2(omoPkg) || !existsSync2(senpiPkg) || !existsSync2(authStoragePath))
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
  const homebrew = join3(homedir3(), ".nvm", "versions");
  if (existsSync2(homebrew)) {}
  for (const root of candidates) {
    const found = fromOmoRoot(root);
    if (found)
      return found;
  }
  return null;
}

// src/panel.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";

// src/table.ts
function cellWidth(s) {
  return [...s].length;
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
    let w = Math.max(c.minWidth ?? 0, cellWidth(c.header));
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
  if (!existsSync3(eventsPath))
    return [];
  const raw = readFileSync3(eventsPath, "utf8");
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
  const grok = remote.windows.find((w) => w.label === "grok" || r.provider === "xai" && (w.kind === "weekly" || w.kind === "period"));
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
    session: r.provider === "openai-codex" ? fmt(session) : "-",
    weekly: r.provider === "openai-codex" ? fmt(weekly) : "-",
    grok: r.provider === "xai" ? fmt(grok) : "-"
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
      profile: r.profile,
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
    const remote = r.provider === "openai-codex" ? `5h=${rc.session} wk=${rc.weekly}` : r.provider === "xai" ? `grok=${rc.grok}` : "";
    const stats = `ok=${r.usage.success} rl=${r.usage.rateLimited}${remote ? " " + remote : ""}`;
    lines.push(`${star}${r.profile}  ${r.availability}  ${stats} | bash=${shellQuote(process.env.HOME + "/.local/bin/oar")} param1=use param2=${r.provider} param3=${r.profile} terminal=false refresh=true`);
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
  if (p === "openai-codex")
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

// src/store.ts
import {
  chmodSync,
  existsSync as existsSync4,
  mkdirSync,
  readFileSync as readFileSync4,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname as dirname2, join as join4 } from "node:path";
var DEFAULT_POLICY = {
  mode: "manual",
  autoFailover: false
};
function emptyState() {
  return { version: 1, providers: {}, accounts: [], updatedAt: new Date().toISOString() };
}
function atomicWriteJson(path, data, mode = 384) {
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
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
    this.rootDir = opts?.rootDir ?? defaultOarRoot2();
    this.statePath = oarStatePath(this.rootDir);
    this.vaultDir = oarVaultDir(this.rootDir);
    mkdirSync(this.rootDir, { recursive: true, mode: 448 });
    mkdirSync(this.vaultDir, { recursive: true, mode: 448 });
    this.state = this.load();
  }
  load() {
    if (!existsSync4(this.statePath))
      return emptyState();
    try {
      const parsed = JSON.parse(readFileSync4(this.statePath, "utf8"));
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
    if (existsSync4(vaultPath)) {
      try {
        unlinkSync(vaultPath);
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
    if (!existsSync4(path))
      return;
    try {
      return JSON.parse(readFileSync4(path, "utf8"));
    } catch {
      return;
    }
  }
}

// src/usage/cache.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync2, readFileSync as readFileSync5, renameSync as renameSync2, writeFileSync as writeFileSync2, chmodSync as chmodSync2 } from "node:fs";
import { dirname as dirname3, join as join5 } from "node:path";
function usageCachePath(root = defaultOarRoot2()) {
  return join5(root, "usage-cache.json");
}
function cacheKey(provider, profile) {
  return `${provider}/${profile}`;
}
function loadUsageCache(root = defaultOarRoot2()) {
  const path = usageCachePath(root);
  if (!existsSync5(path))
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
function saveUsageCache(cache, root = defaultOarRoot2()) {
  const path = usageCachePath(root);
  mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: cache.entries
  };
  writeFileSync2(tmp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 384 });
  renameSync2(tmp, path);
  try {
    chmodSync2(path, 384);
  } catch {}
}
function getCachedUsage(provider, profile, opts) {
  const root = opts?.root ?? defaultOarRoot2();
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
function putCachedUsage(entry, root = defaultOarRoot2()) {
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
  const root = opts?.root ?? store.rootDir ?? defaultOarRoot2();
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
  if (provider === "openai-codex") {
    result = await fetchCodexUsage(provider, profile, cred, { fetchImpl: opts?.fetchImpl });
  } else if (provider === "xai") {
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
    const grok = pick(u.windows, (w) => w.label === "grok" || u.provider === "xai" && (w.kind === "weekly" || w.kind === "period"));
    const primary = u.provider === "xai" ? grok : weekly ?? session ?? u.windows[0];
    return {
      provider: u.provider,
      profile: u.profile,
      ok: "yes",
      session: u.provider === "openai-codex" ? fmtPct(session?.remainingPercent) : "-",
      weekly: u.provider === "openai-codex" ? fmtPct(weekly?.remainingPercent) : "-",
      grok: u.provider === "xai" ? fmtPct(grok?.remainingPercent) : "-",
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
  const root = opts?.root ?? store.rootDir ?? defaultOarRoot2();
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
  if (provider === "openai-codex") {
    result = await fetchCodexUsage(provider, profile, cred, { fetchImpl: opts?.fetchImpl });
  } else if (provider === "xai") {
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
  const targets = accounts.filter((a) => a.provider === "xai" || a.provider === "openai-codex").map((a) => ({ provider: a.provider, profile: a.profile }));
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
var __dirname2 = dirname4(fileURLToPath(import.meta.url));
function usage() {
  return `oar \u2014 OMO Account Router

Tip: run \`oar\` with no args for a quick status snapshot.

Usage:
  oar status
  oar accounts [provider]
  oar provider list
  oar add <provider> <profile>
  oar remove <provider> <profile>
  oar use <provider> <profile> [--force]
  oar auto <provider> on|off
  oar import-auth <provider> <profile> [--from <auth.json>]
  oar import-auth --all [--from <auth.json>] [--profile <name>] [--force]
  oar login <provider> <profile>
  oar logout <provider> <profile>
  oar activate <provider> <profile>
  oar test <provider> <profile> [--live]
  oar report <provider> <profile> <RESULT>
  oar guide second-account
  oar install [-- <install.sh args>]
  oar panel [--watch [sec]] [--json] [--xbar] [--hours N] [--refresh] [--no-remote]
  oar usage [provider] [profile] [--refresh]
  oar recommend [--refresh] [provider...]
  oar doctor
  oar daemon start|stop|status

Environment:
  OAR_HOME   state root (default ~/.oar)
  OAR_SOCK   unix socket path
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
function printStatus(data) {
  const active = new Map(data.resolvePreview.map((r) => [`${r.provider}`, r.profile]));
  console.log("PROVIDER   PROFILE            AUTH       STATUS            MODE     ACTIVE");
  for (const a of data.accounts) {
    const pol = data.state.providers[a.provider];
    const mode = pol?.mode ?? "manual";
    const star = active.get(a.provider) === a.profile ? "\u2605" : "";
    console.log(`${a.provider.padEnd(10)} ${a.profile.padEnd(18)} ${a.auth.padEnd(10)} ${a.availability.padEnd(16)} ${mode.padEnd(8)} ${star}`);
  }
  console.log("");
  console.log("auth paths (active slot writes):");
  for (const p of data.authPaths)
    console.log(`  ${p}`);
}
async function daemonStart() {
  const root = process.env.OAR_HOME ?? defaultOarRoot3();
  const sock = process.env.OAR_SOCK ?? oarSocketPath2(root);
  if (existsSync6(sock)) {
    try {
      const client = new OarClient({ socketPath: sock });
      const pong = await client.request({ protocol: 1, action: "ping" });
      if (pong.ok) {
        console.log(`oar-daemon already running at ${sock}`);
        return;
      }
    } catch {}
  }
  const daemonTs = join6(__dirname2, "daemon-main.ts");
  const daemonJs = join6(__dirname2, "daemon-main.js");
  const daemonEntry = existsSync6(daemonTs) ? daemonTs : daemonJs;
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
  if (!existsSync6(pidPath)) {
    console.log("oar-daemon not running (no pid file)");
    return;
  }
  const pid = Number(readFileSync6(pidPath, "utf8").trim());
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
function readCredentialFromAuthJson(authPath, provider) {
  const data = JSON.parse(readFileSync6(authPath, "utf8"));
  const cred = data[provider];
  if (!cred)
    throw new Error(`provider ${provider} not found in ${authPath}`);
  if (cred.type !== "oauth" && cred.type !== "api_key") {
    throw new Error(`unsupported credential type in ${authPath}`);
  }
  return cred;
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
  if (!cmd) {
    try {
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok)
        throw new Error(res.error);
      const data = res.data;
      printStatus(data);
      console.log("Commands: oar panel --refresh | oar usage | oar use <provider> <profile> | oar --help");
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
      const res = await req({ protocol: 1, action: "status" });
      if (!res.ok)
        throw new Error(res.error);
      printStatus(res.data);
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
      const [provider, profile] = rest;
      if (!provider || !profile)
        throw new Error("usage: oar remove <provider> <profile>");
      const res = await req({ protocol: 1, action: "remove", provider, profile });
      if (!res.ok)
        throw new Error(res.error);
      console.log(`removed ${provider}/${profile}`);
      return;
    }
    case "use": {
      const force = rest.includes("--force");
      const args = rest.filter((a) => a !== "--force");
      const [provider, profile] = args;
      if (!provider || !profile) {
        throw new Error(`usage: oar use <provider> <profile> [--force]
` + suggestAccounts());
      }
      const root = process.env.OAR_HOME ?? defaultOarRoot3();
      const store = new OarStore({ rootDir: root });
      try {
        const u = await fetchRemoteUsage(store, provider, profile, {
          root,
          force: true,
          maxAgeMs: 0
        });
        if (u.ok) {
          const w = u.windows.find((x) => x.remainingPercent != null) ?? u.windows[0];
          if (w?.remainingPercent != null && w.remainingPercent <= 0) {
            console.error(`WARNING: ${provider}/${profile} remote remaining is 0% (${w.label ?? w.kind}).`);
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
              throw new Error(`REFUSED: not switching to ${provider}/${profile} at 0%. ` + `Auto failover will also skip it. Use another profile, or --force to override.`);
            }
            console.error("  --force set: switching anyway.");
          } else if (w?.remainingPercent != null && w.remainingPercent <= 5) {
            console.log(`warning: remote remaining ~${w.remainingPercent}% (${w.label ?? w.kind}).`);
          }
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
      let from = join6(homedir4(), ".omo", "agent", "auth.json");
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
      const [provider, profile] = rest;
      if (!provider || !profile) {
        throw new Error(`usage: oar import-auth <provider> <profile> [--from path]
   or: oar import-auth --all [--from path] [--profile name] [--force]`);
      }
      const credential = readCredentialFromAuthJson(from, provider);
      const res = await req({
        protocol: 1,
        action: "import-credential",
        provider,
        profile,
        credential
      });
      if (!res.ok)
        throw new Error(res.error);
      console.log(`imported ${provider}/${profile} from ${from} (secrets stored under OAR vault, not logged)`);
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
      const scriptPath = join6(__dirname2, "..", "scripts", "install.sh");
      if (!existsSync6(scriptPath)) {
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
      const [provider, profile] = rest;
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
      const root = process.env.OAR_HOME ?? defaultOarRoot3();
      const store = new OarStore({ rootDir: root });
      const renderOnce = async () => {
        const res = await req({ protocol: 1, action: "status" });
        if (!res.ok)
          throw new Error(res.error);
        const status = res.data;
        let remoteUsage = undefined;
        if (!noRemote) {
          const targets = (status.accounts ?? []).filter((a) => a.provider === "openai-codex" || a.provider === "xai").map((a) => ({ provider: a.provider, profile: a.profile }));
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
      const refresh = rest.includes("--refresh");
      const args = rest.filter((a) => !a.startsWith("--"));
      const root = process.env.OAR_HOME ?? defaultOarRoot3();
      const store = new OarStore({ rootDir: root });
      const provider = args[0];
      const profile = args[1];
      const targets = provider && profile ? [{ provider, profile }] : store.listAccounts().filter((a) => a.provider === "openai-codex" || a.provider === "xai").map((a) => ({ provider: a.provider, profile: a.profile }));
      if (targets.length === 0) {
        console.log("no openai-codex / xai accounts in vault");
        return;
      }
      const rows = await fetchRemoteUsageForAccounts(store, targets, {
        root,
        force: refresh || true,
        maxAgeMs: 0
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
      const refresh = rest.includes("--refresh") || !rest.includes("--cache");
      const providers = rest.filter((a) => !a.startsWith("--"));
      const root = process.env.OAR_HOME ?? defaultOarRoot3();
      const store = new OarStore({ rootDir: root });
      try {
        const st = await req({ protocol: 1, action: "accounts" });
        if (st.ok && Array.isArray(st.data)) {}
      } catch {}
      const rows = await buildRecommendations(store, {
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
      console.log(formatRecommendTable(rows));
      return;
    }
    case "doctor": {
      console.log("OAR doctor");
      console.log(`root: ${process.env.OAR_HOME ?? defaultOarRoot3()}`);
      console.log(`sock: ${process.env.OAR_SOCK ?? oarSocketPath2()}`);
      const install = findSenpiInstall();
      if (install) {
        console.log(`omo-ai: ${install.omoAiVersion}`);
        console.log(`senpi:  ${install.senpiVersion}`);
        console.log(`engine: ${install.senpiRoot}`);
      } else {
        console.log("omo-ai/senpi install: not found");
      }
      console.log("active auth paths:");
      for (const p of resolveActiveAuthPaths()) {
        console.log(`  ${existsSync6(p) ? "OK" : "--"} ${p}`);
      }
      console.log("discovered auth.json:");
      for (const p of discoverAuthJsonFiles()) {
        console.log(`  ${p}`);
      }
      await daemonStatus();
      console.log("");
      console.log("tips:");
      console.log("  oar panel --refresh   # accounts + remaining %");
      console.log("  oar usage --refresh   # Codex WK/5H + Grok %");
      console.log("  oar use <p> <profile> # hot-switch live slot");
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
      throw new Error(`unknown command: ${cmd}
${usage()}`);
  }
}
main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
