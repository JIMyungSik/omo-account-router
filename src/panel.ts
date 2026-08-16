import { existsSync, readFileSync } from "node:fs";
import { oarEventsPath } from "./paths.ts";
import type { AccountRecord, OarState, ProviderPolicy, ResolveResponse } from "./types.ts";

export type PanelLease = {
  id: string;
  provider: string;
  profile: string;
  holder: string;
  acquiredAt: string;
};

export type StatusPayload = {
  state: OarState;
  authPaths: string[];
  accounts: AccountRecord[];
  leases?: PanelLease[];
  resolvePreview: ResolveResponse[];
};

export type AccountUsageStats = {
  provider: string;
  profile: string;
  success: number;
  rateLimited: number;
  quotaExhausted: number;
  authFailed: number;
  failover: number;
  switches: number;
  lastEventAt?: string;
  lastResult?: string;
};

export type PanelRow = {
  provider: string;
  profile: string;
  auth: string;
  availability: string;
  mode: string;
  autoFailover: boolean;
  preferred: boolean;
  active: boolean;
  lastUsedAt?: string;
  until?: string | null;
  reason?: string;
  usage: AccountUsageStats;
};

export type PanelSnapshot = {
  generatedAt: string;
  windowHours: number;
  authPaths: string[];
  rows: PanelRow[];
  leases: PanelLease[];
  totals: {
    accounts: number;
    active: number;
    success: number;
    rateLimited: number;
    quotaExhausted: number;
    authFailed: number;
  };
  notes: string[];
};

export type OarEventLine = {
  ts?: string;
  event?: string;
  provider?: string;
  profile?: string;
  reason?: string;
};

function keyOf(provider: string, profile: string): string {
  return `${provider}\0${profile}`;
}

/** Read recent events.jsonl without secrets (events are already scrubbed on write). */
export function readEventLines(eventsPath: string, opts?: { sinceMs?: number; maxLines?: number }): OarEventLine[] {
  if (!existsSync(eventsPath)) return [];
  const raw = readFileSync(eventsPath, "utf8");
  if (!raw.trim()) return [];
  const maxLines = opts?.maxLines ?? 50_000;
  const all = raw.split("\n").filter(Boolean);
  const slice = all.length > maxLines ? all.slice(all.length - maxLines) : all;
  const since = opts?.sinceMs ?? 0;
  const out: OarEventLine[] = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line) as OarEventLine;
      if (since > 0 && parsed.ts) {
        const t = Date.parse(parsed.ts);
        if (Number.isFinite(t) && t < since) continue;
      }
      out.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function aggregateUsage(events: OarEventLine[]): Map<string, AccountUsageStats> {
  const map = new Map<string, AccountUsageStats>();

  const touch = (provider?: string, profile?: string): AccountUsageStats | null => {
    if (!provider || !profile) return null;
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
        switches: 0,
      };
      map.set(k, row);
    }
    return row;
  };

  for (const ev of events) {
    const row = touch(ev.provider, ev.profile);
    if (!row) continue;
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
      if (reason === "SUCCESS") row.success += 1;
      else if (reason === "RATE_LIMITED") row.rateLimited += 1;
      else if (reason === "QUOTA_EXHAUSTED") row.quotaExhausted += 1;
      else if (reason === "AUTH_REVOKED" || reason === "AUTH_EXPIRED") row.authFailed += 1;
    } else if (event === "refresh_failed") {
      row.authFailed += 1;
      row.lastResult = reason || "refresh_failed";
    }
  }
  return map;
}

function emptyUsage(provider: string, profile: string): AccountUsageStats {
  return {
    provider,
    profile,
    success: 0,
    rateLimited: 0,
    quotaExhausted: 0,
    authFailed: 0,
    failover: 0,
    switches: 0,
  };
}

export function buildPanelSnapshot(
  status: StatusPayload,
  opts?: { windowHours?: number; eventsPath?: string; rootDir?: string },
): PanelSnapshot {
  const windowHours = opts?.windowHours ?? 24;
  const sinceMs = Date.now() - windowHours * 3600_000;
  const eventsPath = opts?.eventsPath ?? (opts?.rootDir ? oarEventsPath(opts.rootDir) : oarEventsPath());
  const usageMap = aggregateUsage(readEventLines(eventsPath, { sinceMs }));

  const activeByProvider = new Map<string, string>();
  for (const r of status.resolvePreview ?? []) {
    if (r.status === "available" && r.profile) activeByProvider.set(r.provider, r.profile);
  }

  const policies: Record<string, ProviderPolicy> = status.state?.providers ?? {};
  const rows: PanelRow[] = [];

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
    });
  }

  rows.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    return a.profile.localeCompare(b.profile);
  });

  const totals = {
    accounts: rows.length,
    active: rows.filter((r) => r.active).length,
    success: rows.reduce((n, r) => n + r.usage.success, 0),
    rateLimited: rows.reduce((n, r) => n + r.usage.rateLimited, 0),
    quotaExhausted: rows.reduce((n, r) => n + r.usage.quotaExhausted, 0),
    authFailed: rows.reduce((n, r) => n + r.usage.authFailed, 0),
  };

  return {
    generatedAt: new Date().toISOString(),
    windowHours,
    authPaths: status.authPaths ?? [],
    rows,
    leases: status.leases ?? [],
    totals,
    notes: [
      "ACTIVE ★ = currently preferred/resolved live slot for that provider (shared by all omo sessions).",
      "ok/rl/quota/auth columns are local OAR signals from events.jsonl in the time window — not provider billing dashboards.",
      "True remaining quota/$ requires each provider's usage API (not wired yet; adapters.supportsUsageQuery is still false).",
    ],
  };
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function shortTime(iso?: string | null): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  return new Date(t).toLocaleString();
}

/** Human table for terminal. */
export function formatPanelText(snap: PanelSnapshot): string {
  const lines: string[] = [];
  lines.push(`OAR panel  ·  window ${snap.windowHours}h  ·  ${snap.generatedAt}`);
  lines.push(
    `accounts ${snap.totals.accounts}  active ${snap.totals.active}  ok ${snap.totals.success}  rl ${snap.totals.rateLimited}  quota ${snap.totals.quotaExhausted}  authfail ${snap.totals.authFailed}`,
  );
  lines.push("");
  lines.push(
    `${pad("PROV", 14)}${pad("PROFILE", 12)}${pad("AUTH", 8)}${pad("STATUS", 14)}${pad("MODE", 8)}${pad("AUTO", 5)}${pad("OK", 5)}${pad("RL", 4)}${pad("QUOTA", 6)}${pad("AF", 4)}${pad("LAST", 20)}A`,
  );
  lines.push("-".repeat(110));
  for (const r of snap.rows) {
    const mark = r.active ? "★" : r.preferred ? "·" : " ";
    const auto = r.autoFailover ? "on" : "off";
    lines.push(
      `${pad(r.provider, 14)}${pad(r.profile, 12)}${pad(r.auth, 8)}${pad(r.availability, 14)}${pad(r.mode, 8)}${pad(auto, 5)}${pad(String(r.usage.success), 5)}${pad(String(r.usage.rateLimited), 4)}${pad(String(r.usage.quotaExhausted), 6)}${pad(String(r.usage.authFailed), 4)}${pad(shortTime(r.usage.lastEventAt ?? r.lastUsedAt), 20)}${mark}`,
    );
  }
  if (snap.leases.length > 0) {
    lines.push("");
    lines.push("leases:");
    for (const l of snap.leases) {
      lines.push(`  ${l.provider}/${l.profile}  holder=${l.holder}  since=${l.acquiredAt}`);
    }
  }
  lines.push("");
  lines.push("auth paths:");
  for (const p of snap.authPaths) lines.push(`  ${p}`);
  lines.push("");
  for (const n of snap.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}

/** SwiftBar / xbar menubar plugin body. */
export function formatPanelXbar(snap: PanelSnapshot): string {
  const active = snap.rows.filter((r) => r.active);
  const titleParts = active.map((r) => `${shortProv(r.provider)}:${r.profile}`);
  const title = titleParts.length > 0 ? `OAR ${titleParts.join(" ")}` : "OAR";
  const lines: string[] = [title, "---"];
  lines.push(`Refresh panel | bash=/usr/bin/true refresh=true`);
  lines.push(`Window: last ${snap.windowHours}h | size=12`);
  lines.push("---");
  let lastProv = "";
  for (const r of snap.rows) {
    if (r.provider !== lastProv) {
      lines.push(`${r.provider}  mode=${r.mode} auto=${r.autoFailover ? "on" : "off"} | size=12`);
      lastProv = r.provider;
    }
    const star = r.active ? "★ " : "  ";
    const stats = `ok=${r.usage.success} rl=${r.usage.rateLimited} q=${r.usage.quotaExhausted}`;
    lines.push(
      `${star}${r.profile}  ${r.availability}  ${stats} | bash=${shellQuote(process.env.HOME + "/.local/bin/oar")} param1=use param2=${r.provider} param3=${r.profile} terminal=false refresh=true`,
    );
  }
  lines.push("---");
  lines.push("Open status in terminal | bash=" + shellQuote((process.env.HOME || "") + "/.local/bin/oar") + " param1=panel terminal=true");
  lines.push("Doctor | bash=" + shellQuote((process.env.HOME || "") + "/.local/bin/oar") + " param1=doctor terminal=true");
  lines.push("---");
  lines.push("Local event signals only — not provider $ billing");
  return lines.join("\n");
}

function shortProv(p: string): string {
  if (p === "openai-codex") return "codex";
  if (p === "zai-coding-cn") return "zai";
  if (p === "opencode-go") return "ocgo";
  return p;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
