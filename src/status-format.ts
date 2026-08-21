import { formatMarkdownTable } from "./table.ts";
import type { AccountAvailability, AccountRecord, AuthHealth } from "./types.ts";

export type StatusResolvePreview = {
  provider: string;
  profile: string;
  status: string;
};

export type StatusInput = {
  accounts: AccountRecord[];
  resolvePreview: StatusResolvePreview[];
  authPaths: string[];
  state: {
    providers: Record<string, { mode: string; preferred?: string; autoFailover: boolean }>;
  };
};

export type StatusRowView = {
  active: boolean;
  provider: string;
  profile: string;
  auth: AuthHealth;
  availability: AccountAvailability;
  mode: string;
  autoFailover: boolean;
  preferred: boolean;
  until?: string | null;
  reason?: string;
  note: string;
};

export type StatusSummary = {
  accounts: number;
  active: number;
  problematic: number;
};

export type StatusView = {
  summary: StatusSummary;
  rows: StatusRowView[];
  authPaths: string[];
};

export type StatusJson = {
  summary: StatusSummary;
  rows: Array<{
    active: boolean;
    provider: string;
    profile: string;
    auth: AuthHealth;
    status: AccountAvailability;
    mode: string;
    auto: boolean;
    preferred: boolean;
    note: string;
    until: string | null;
    reason: string | null;
  }>;
  authPaths: string[];
};

const PROBLEMATIC_AVAIL: ReadonlySet<AccountAvailability> = new Set([
  "QUOTA_EXHAUSTED",
  "AUTH_EXPIRED",
  "AUTH_REVOKED",
  "RATE_LIMITED",
]);

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
} as const;

export function isProblematicAccount(account: Pick<AccountRecord, "auth" | "availability">): boolean {
  if (PROBLEMATIC_AVAIL.has(account.availability)) return true;
  return account.auth === "expired" || account.auth === "revoked";
}

function shortUntil(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function buildNote(account: AccountRecord): string {
  const until = shortUntil(account.until);
  const reason = account.reason?.trim() || undefined;
  if (reason && until) return `${reason} · until ${until}`;
  if (reason) return reason;
  if (until) return `until ${until}`;
  return "";
}

export function buildStatusView(data: StatusInput): StatusView {
  const activeByProvider = new Map(data.resolvePreview.map((r) => [r.provider, r.profile]));
  const rows: StatusRowView[] = data.accounts.map((account) => {
    const pol = data.state.providers[account.provider];
    const active = activeByProvider.get(account.provider) === account.profile;
    return {
      active,
      provider: account.provider,
      profile: account.profile,
      auth: account.auth,
      availability: account.availability,
      mode: pol?.mode ?? "manual",
      autoFailover: Boolean(pol?.autoFailover),
      preferred: pol?.preferred === account.profile,
      until: account.until ?? null,
      reason: account.reason,
      note: buildNote(account),
    };
  });

  rows.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.profile.localeCompare(b.profile);
  });

  return {
    summary: {
      accounts: rows.length,
      active: rows.filter((r) => r.active).length,
      problematic: rows.filter((r) => isProblematicAccount(r)).length,
    },
    rows,
    authPaths: data.authPaths ?? [],
  };
}

export function statusViewToJson(view: StatusView): StatusJson {
  return {
    summary: view.summary,
    rows: view.rows.map((r) => ({
      active: r.active,
      provider: r.provider,
      profile: r.profile,
      auth: r.auth,
      status: r.availability,
      mode: r.mode,
      auto: r.autoFailover,
      preferred: r.preferred,
      note: r.note,
      until: r.until ?? null,
      reason: r.reason ?? null,
    })),
    authPaths: view.authPaths,
  };
}

function paint(enabled: boolean, code: string, text: string): string {
  if (!enabled || text === "") return text;
  return `${code}${text}${ANSI.reset}`;
}

function colorAuth(enabled: boolean, auth: AuthHealth): string {
  if (auth === "valid") return paint(enabled, ANSI.green, auth);
  if (auth === "expired" || auth === "revoked") return paint(enabled, ANSI.red, auth);
  return paint(enabled, ANSI.dim, auth);
}

function colorStatus(enabled: boolean, availability: AccountAvailability): string {
  if (PROBLEMATIC_AVAIL.has(availability)) return paint(enabled, ANSI.red, availability);
  if (availability === "AVAILABLE" || availability === "ACTIVE") {
    return paint(enabled, ANSI.green, availability);
  }
  if (availability === "COOLDOWN" || availability === "REQUIRES_LOGIN") {
    return paint(enabled, ANSI.yellow, availability);
  }
  return availability;
}

export function wantStatusColor(env: NodeJS.ProcessEnv = process.env, stdout: { isTTY?: boolean } = process.stdout): boolean {
  return Boolean(stdout.isTTY) && !env.NO_COLOR;
}

export function formatStatusText(view: StatusView, opts?: { color?: boolean }): string {
  const color = opts?.color ?? false;
  const lines: string[] = [];
  const { accounts, active, problematic } = view.summary;
  lines.push(
    `OAR status  ·  accounts ${accounts}  active ${active}  problematic ${problematic}`,
  );
  lines.push("");
  lines.push(
    formatMarkdownTable(
      [
        { key: "active", header: "" },
        { key: "provider", header: "PROVIDER" },
        { key: "profile", header: "PROFILE" },
        { key: "auth", header: "AUTH" },
        { key: "status", header: "STATUS" },
        { key: "mode", header: "MODE" },
        { key: "auto", header: "AUTO" },
        { key: "note", header: "NOTE" },
      ],
      view.rows.map((r) => ({
        active: r.active ? "*" : "",
        provider: r.provider,
        profile: r.profile,
        auth: colorAuth(color, r.auth),
        status: colorStatus(color, r.availability),
        mode: r.mode,
        auto: r.autoFailover ? "on" : "off",
        note: r.note,
      })),
    ),
  );
  lines.push("");
  lines.push("Legend:");
  lines.push("  AUTH    Vault/import health (valid | expired | revoked | unknown).");
  lines.push("  STATUS  Routing eligibility (AVAILABLE, QUOTA_EXHAUSTED, RATE_LIMITED, …).");
  lines.push("  ACTIVE  * = live auth slot for that provider (target of oar use).");
  lines.push("");
  lines.push("Next: oar panel --refresh | oar usage | oar use <provider> <profile>");
  lines.push("");
  lines.push("auth paths (active slot writes):");
  if (view.authPaths.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of view.authPaths) lines.push(`  ${p}`);
  }
  return lines.join("\n");
}
