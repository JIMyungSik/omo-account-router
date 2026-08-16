import { isEligible } from "../router.ts";
import type { OarStore } from "../store.ts";
import { formatMarkdownTable } from "../table.ts";
import type { AccountRecord } from "../types.ts";
import { fetchRemoteUsageForAccounts } from "./fetch.ts";
import type { AccountRemoteUsage } from "./types.ts";

export type RecommendRow = {
  rank: number;
  provider: string;
  profile: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  windowLabel: string;
  eligibility: string;
  live: boolean;
  score: number;
  note: string;
  resetsAt?: string | null;
};

function primaryWindow(u: AccountRemoteUsage | undefined): {
  remainingPercent: number | null;
  usedPercent: number | null;
  label: string;
  resetsAt?: string | null;
} {
  if (!u?.ok || u.windows.length === 0) {
    return { remainingPercent: null, usedPercent: null, label: "-", resetsAt: null };
  }
  // Prefer grok/session/weekly windows with a remaining value
  const ranked = [...u.windows].sort((a, b) => {
    const ar = a.remainingPercent ?? -1;
    const br = b.remainingPercent ?? -1;
    return br - ar;
  });
  const w = ranked.find((x) => x.remainingPercent != null) ?? ranked[0]!;
  return {
    remainingPercent: w.remainingPercent,
    usedPercent: w.usedPercent,
    label: w.label ?? w.kind,
    resetsAt: w.resetsAt,
  };
}

function scoreAccount(
  account: AccountRecord,
  usage: AccountRemoteUsage | undefined,
  preferred?: string,
): { score: number; note: string; remainingPercent: number | null; usedPercent: number | null; label: string; resetsAt?: string | null } {
  const win = primaryWindow(usage);
  let score = 0;
  const notes: string[] = [];

  if (!isEligible(account)) {
    score = -1000;
    notes.push(account.availability === "QUOTA_EXHAUSTED" ? "0%/exhausted" : account.availability);
  } else {
    score += 100;
  }

  if (win.remainingPercent != null) {
    score += win.remainingPercent; // 0..100
    if (win.remainingPercent <= 0) {
      score -= 500;
      notes.push("remote 0%");
    } else if (win.remainingPercent <= 5) {
      notes.push("low remaining");
    }
  } else if (usage && !usage.ok) {
    score += 10; // unknown remote, still eligible vault account
    notes.push(usage.error ? `usage err` : "no remote %");
  } else {
    score += 15;
    notes.push("no remote %");
  }

  if (preferred && account.profile === preferred && isEligible(account)) {
    score += 5; // slight sticky bonus
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
    resetsAt: win.resetsAt,
  };
}

export async function buildRecommendations(
  store: OarStore,
  opts?: { root?: string; force?: boolean; providers?: string[] },
): Promise<RecommendRow[]> {
  const root = opts?.root ?? defaultOarRoot();
  let accounts = store.listAccounts();
  if (opts?.providers?.length) {
    const set = new Set(opts.providers);
    accounts = accounts.filter((a) => set.has(a.provider));
  }

  const targets = accounts
    .filter((a) => a.provider === "xai" || a.provider === "openai-codex")
    .map((a) => ({ provider: a.provider, profile: a.profile }));

  // Also include other providers without remote usage (eligibility only)
  const usageList =
    targets.length > 0
      ? await fetchRemoteUsageForAccounts(store, targets, {
          root,
          force: opts?.force ?? true,
          maxAgeMs: opts?.force ? 0 : 60_000,
        })
      : [];
  const usageMap = new Map(usageList.map((u) => [`${u.provider}\0${u.profile}`, u]));

  const preferredByProvider = new Map<string, string | undefined>();
  for (const a of accounts) {
    if (!preferredByProvider.has(a.provider)) {
      preferredByProvider.set(a.provider, store.getProviderPolicy(a.provider).preferred);
    }
  }

  const scored = accounts.map((a) => {
    const u = usageMap.get(`${a.provider}\0${a.profile}`);
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
      resetsAt: s.resetsAt,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ar = a.remainingPercent ?? -1;
    const br = b.remainingPercent ?? -1;
    if (br !== ar) return br - ar;
    return `${a.provider}/${a.profile}`.localeCompare(`${b.provider}/${b.profile}`);
  });

  return scored.map((row, i) => ({ ...row, rank: i + 1 }));
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n}%`;
}

function shortReset(iso?: string | null): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function formatRecommendTable(rows: RecommendRow[]): string {
  if (rows.length === 0) return "OAR recommend\n(no accounts in vault)";

  const top = rows.find((r) => r.score > 0 && r.eligibility === "ok");
  const table = formatMarkdownTable(
    [
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
      { key: "note", header: "NOTE" },
    ],
    rows.map((r) => ({
      rank: r.rank,
      provider: r.provider,
      profile: r.profile,
      left: fmtPct(r.remainingPercent),
      used: fmtPct(r.usedPercent),
      window: r.windowLabel,
      elig: r.eligibility,
      live: r.live ? "*" : "",
      score: Math.round(r.score),
      reset: shortReset(r.resetsAt),
      note: r.note,
    })),
  );

  const lines = [
    "OAR recommend (higher rank = better to use next)",
    table,
    "",
  ];
  if (top) {
    lines.push(
      `top pick: ${top.provider}/${top.profile}` +
        (top.remainingPercent != null ? `  (${top.remainingPercent}% left)` : ""),
    );
    lines.push(`switch:   oar use ${top.provider} ${top.profile}`);
  } else {
    lines.push("top pick: (none eligible — all exhausted or blocked)");
  }
  lines.push("");
  lines.push(
    "Score = eligibility + remote remaining %. QUOTA_EXHAUSTED / 0% are ranked last and skipped by auto.",
  );
  lines.push("This does not change the session model — only which account OAR would activate.");
  return lines.join("\n");
}
