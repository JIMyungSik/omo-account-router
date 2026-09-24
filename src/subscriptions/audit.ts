import { isCodexProvider, isXaiProvider } from "../provider-alias.ts";
import { isEligible } from "../router.ts";
import type { OarStore } from "../store.ts";
import type { AccountRecord } from "../types.ts";
import { buildRecommendations } from "../usage/recommend.ts";
import type { AccountRemoteUsage } from "../usage/types.ts";
import { fetchRemoteUsageForAccounts } from "../usage/fetch.ts";
import type { SubscriptionPlan } from "./store.ts";
import { SubscriptionsStore } from "./store.ts";

export type AuditRecommendation = "keep" | "demote" | "cancel candidate" | "fix first" | "unset cost";

export type AuditRow = {
  provider: string;
  profile: string;
  planLabel: string;
  monthlyUsd: number | null;
  usageSummary: string;
  status: string;
  recommend: AuditRecommendation;
  savePerMonth: number | null;
  note: string;
};

export type AuditResult = {
  generatedAt: string;
  totalConfiguredUsd: number;
  potentialSavingsUsd: number;
  rows: AuditRow[];
  summary: {
    keep: string[];
    cancel: string[];
    fix: string[];
    demote: string[];
    unsetCost: string[];
  };
};

function primaryUsage(u: AccountRemoteUsage | undefined): {
  remainingPercent: number | null;
  label: string;
  ok: boolean;
  error?: string;
} {
  if (!u) return { remainingPercent: null, label: "-", ok: false };
  if (!u.ok) {
    return { remainingPercent: null, label: "-", ok: false, error: u.error };
  }
  const ranked = [...u.windows].sort((a, b) => (b.remainingPercent ?? -1) - (a.remainingPercent ?? -1));
  const w = ranked.find((x) => x.remainingPercent != null) ?? ranked[0];
  if (!w) return { remainingPercent: null, label: "-", ok: true };
  return {
    remainingPercent: w.remainingPercent,
    label: w.label ?? w.kind,
    ok: true,
  };
}

function usageSummary(account: AccountRecord, u: AccountRemoteUsage | undefined): string {
  const p = primaryUsage(u);
  if (!u) return account.availability;
  if (!u.ok) return u.error ?? "usage error";
  if (p.remainingPercent != null) return `${p.remainingPercent}% ${p.label}`;
  return account.availability;
}

function isAuthBroken(u: AccountRemoteUsage | undefined): boolean {
  if (!u || u.ok) return false;
  return /401|403|invalid_grant/i.test(u.error ?? "");
}

function classifyRow(
  account: AccountRecord,
  plan: SubscriptionPlan | undefined,
  u: AccountRemoteUsage | undefined,
  isTopPick: boolean,
  isActive: boolean,
  siblingHasEligible: boolean,
): { recommend: AuditRecommendation; note: string; savePerMonth: number | null } {
  const monthly = plan?.monthlyUsd ?? null;
  const p = primaryUsage(u);

  if (monthly == null) {
    return {
      recommend: "unset cost",
      note: "run: oar subscriptions set … --monthly-usd <n>",
      savePerMonth: null,
    };
  }

  if (isAuthBroken(u)) {
    if (siblingHasEligible) {
      return {
        recommend: "fix first",
        note: "usage auth error — re-auth before cancel; sibling can cover workload",
        savePerMonth: null,
      };
    }
    return {
      recommend: "fix first",
      note: "usage auth error — oar doctor for remediation",
      savePerMonth: null,
    };
  }

  if (account.availability === "QUOTA_EXHAUSTED" || (p.remainingPercent != null && p.remainingPercent <= 0)) {
    if (isTopPick || isActive) {
      return {
        recommend: "keep",
        note: "exhausted but primary/active — switch before cancel",
        savePerMonth: null,
      };
    }
    if (siblingHasEligible) {
      return {
        recommend: "cancel candidate",
        note: "0% / exhausted with eligible sibling",
        savePerMonth: monthly,
      };
    }
    return {
      recommend: "keep",
      note: "only eligible profile for provider — do not cancel all",
      savePerMonth: null,
    };
  }

  if (isTopPick || isActive) {
    return { recommend: "keep", note: isActive ? "active slot" : "recommend top pick", savePerMonth: null };
  }

  if (isEligible(account) && p.remainingPercent != null && p.remainingPercent > 0) {
    return {
      recommend: "demote",
      note: "eligible duplicate — lower priority vs sibling",
      savePerMonth: null,
    };
  }

  if (!isEligible(account) && siblingHasEligible) {
    return {
      recommend: "cancel candidate",
      note: `${account.availability} with sibling coverage`,
      savePerMonth: monthly,
    };
  }

  return { recommend: "keep", note: "default keep (provider guard)", savePerMonth: null };
}

export async function buildSubscriptionAudit(
  oarStore: OarStore,
  subsStore: SubscriptionsStore,
  opts?: { root?: string; force?: boolean },
): Promise<AuditResult> {
  const root = opts?.root ?? oarStore.rootDir;
  const accounts = oarStore.listAccounts();
  const plans = subsStore.list();
  const planMap = new Map(plans.map((p) => [`${p.provider}\0${p.profile}`, p]));

  const usageTargets = accounts
    .filter((a) => isXaiProvider(a.provider) || isCodexProvider(a.provider))
    .map((a) => ({ provider: a.provider, profile: a.profile }));
  const usageList =
    usageTargets.length > 0
      ? await fetchRemoteUsageForAccounts(oarStore, usageTargets, {
          root,
          force: opts?.force ?? false,
          maxAgeMs: opts?.force ? 0 : 300_000,
        })
      : [];
  const usageMap = new Map(usageList.map((u) => [`${u.provider}\0${u.profile}`, u]));

  const recommendRows = await buildRecommendations(oarStore, { root, force: opts?.force ?? false });
  const topPick = recommendRows.find((r) => r.score > 0 && r.eligibility === "ok");
  const topKey = topPick ? `${topPick.provider}\0${topPick.profile}` : null;

  const activeByProvider = new Map<string, string>();
  for (const r of recommendRows) {
    if (r.live) activeByProvider.set(r.provider, r.profile);
  }

  const eligibleByProvider = new Map<string, boolean>();
  for (const a of accounts) {
    if (isEligible(a)) eligibleByProvider.set(a.provider, true);
  }

  const rows: AuditRow[] = accounts.map((account) => {
    const key = `${account.provider}\0${account.profile}`;
    const plan = planMap.get(key);
    const u = usageMap.get(key);
    const siblingHasEligible =
      accounts.filter((a) => a.provider === account.provider && a.profile !== account.profile).some(isEligible) ||
      Boolean(eligibleByProvider.get(account.provider));
    const isTopPick = topKey === key;
    const isActive = activeByProvider.get(account.provider) === account.profile;
    const { recommend, note, savePerMonth } = classifyRow(
      account,
      plan,
      u,
      isTopPick,
      isActive,
      siblingHasEligible,
    );
    return {
      provider: account.provider,
      profile: account.profile,
      planLabel: plan?.planLabel ?? "-",
      monthlyUsd: plan?.monthlyUsd ?? null,
      usageSummary: usageSummary(account, u),
      status: account.availability,
      recommend,
      savePerMonth,
      note,
    };
  });

  rows.sort((a, b) =>
    a.provider === b.provider ? a.profile.localeCompare(b.profile) : a.provider.localeCompare(b.provider),
  );

  const totalConfiguredUsd = plans.reduce((s, p) => s + p.monthlyUsd, 0);
  const potentialSavingsUsd = rows
    .filter((r) => r.recommend === "cancel candidate" && r.savePerMonth != null)
    .reduce((s, r) => s + (r.savePerMonth ?? 0), 0);

  const fmt = (r: AuditRow) => `${r.provider}/${r.profile}`;

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
      unsetCost: rows.filter((r) => r.recommend === "unset cost").map(fmt),
    },
  };
}
