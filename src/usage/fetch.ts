
function isUnreportedUsage(usage: AccountRemoteUsage): boolean {
  if (usage.extras?.unreported === true) return true;
  const primary =
    usage.windows.find((w) => w.remainingPercent != null) ?? usage.windows[0];
  return !primary || primary.remainingPercent == null;
}

function applyUsageToAccountState(store: OarStore, usage: AccountRemoteUsage): void {
  const account = store.getAccount(usage.provider, usage.profile);
  if (!account || !usage.ok) return;
  const primary =
    usage.windows.find((w) => w.remainingPercent != null) ?? usage.windows[0];

  // Authenticated provider-unreported usage is not 0%. Do not exhaust.
  // Mark QUOTA_UNKNOWN so auto-failover will not treat the account as verified-positive.
  if (isUnreportedUsage(usage) || !primary || primary.remainingPercent == null) {
    if (
      account.availability === "QUOTA_EXHAUSTED" ||
      account.availability === "AVAILABLE" ||
      account.availability === "ACTIVE" ||
      account.availability === "UNKNOWN"
    ) {
      store.upsertAccount({
        ...account,
        availability: "QUOTA_UNKNOWN",
        reason: "remote_usage_unreported",
        until: null,
        lastChecked: usage.fetchedAt,
      });
    }
    return;
  }

  if (primary.remainingPercent <= 0 || primary.limitReached) {
    const next: AccountRecord = {
      ...account,
      availability: "QUOTA_EXHAUSTED",
      reason: `remote_usage_${primary.label ?? primary.kind}_0`,
      lastChecked: usage.fetchedAt,
      until: primary.resetsAt ?? null,
    };
    store.upsertAccount(next);
  } else if (account.availability === "QUOTA_EXHAUSTED" && primary.remainingPercent > 5) {
    // recover when remote says we have headroom again
    store.upsertAccount({
      ...account,
      availability: "AVAILABLE",
      reason: undefined,
      until: null,
      lastChecked: usage.fetchedAt,
    });
  } else if (account.availability === "QUOTA_UNKNOWN" && primary.remainingPercent > 0 && !primary.limitReached) {
    store.upsertAccount({
      ...account,
      availability: "AVAILABLE",
      reason: undefined,
      until: null,
      lastChecked: usage.fetchedAt,
    });
  }
}

import { defaultOarRoot } from "../paths.ts";
import { resolveProvider } from "../provider-alias.ts";
import type { OarStore } from "../store.ts";
import type { AccountRecord } from "../types.ts";
import { getCachedUsage, putCachedUsage } from "./cache.ts";
import { fetchCodexUsage } from "./codex.ts";
import type { AccountRemoteUsage } from "./types.ts";
import { fetchXaiGrokSubscriptionUsage } from "./xai-grok.ts";

function attachUsageHttpDiagnostics(usage: AccountRemoteUsage): AccountRemoteUsage {
  if (usage.ok || !usage.error) return usage;
  const match = /\bHTTP (\d+)\b/.exec(usage.error);
  if (!match) return usage;
  const httpStatus = Number(match[1]);
  if (!Number.isFinite(httpStatus)) return usage;
  const extras: Record<string, unknown> = { ...usage.extras, httpStatus };
  if (httpStatus === 401 && usage.source === "codex-wham") {
    extras.diagnostic = "chatgpt-wham-unauthorized";
  }
  return { ...usage, extras };
}

export type FetchUsageOptions = {
  root?: string;
  /** Skip network when cache younger than this (ms). Default 60s. */
  maxAgeMs?: number;
  /** Force network refresh */
  force?: boolean;
  /** Persist usage-derived availability. Default true. */
  applyState?: boolean;
  /** Persist the fetched usage snapshot. Default true. */
  persistCache?: boolean;
  /** Stop a batch before dequeuing another account. */
  shouldContinue?: () => boolean;
  fetchImpl?: typeof fetch;
};

export async function fetchRemoteUsage(
  store: OarStore,
  provider: string,
  profile: string,
  opts?: FetchUsageOptions,
): Promise<AccountRemoteUsage> {
  const root = opts?.root ?? store.rootDir ?? defaultOarRoot();
  const maxAgeMs = opts?.maxAgeMs ?? 60_000;
  if (!opts?.force) {
    const cached = getCachedUsage(provider, profile, { maxAgeMs, root });
    if (cached) return cached;
  }

  const cred = store.getVaultCredential(provider, profile);
  if (!cred) {
    const miss: AccountRemoteUsage = {
      provider,
      profile,
      source: "none",
      fetchedAt: new Date().toISOString(),
      ok: false,
      error: "missing vault credential",
      windows: [],
    };
    if (opts?.persistCache !== false) {
      putCachedUsage(miss, root);
    }
    return miss;
  }

  let result: AccountRemoteUsage;
  if (resolveProvider(provider) === "chatgpt-subscription") {
    result = await fetchCodexUsage(provider, profile, cred, { fetchImpl: opts?.fetchImpl });
    result = attachUsageHttpDiagnostics(result);
  } else if (resolveProvider(provider) === "xai") {
    result = await fetchXaiGrokSubscriptionUsage(provider, profile, cred, {
      fetchImpl: opts?.fetchImpl,
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
      windows: [],
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

export async function fetchRemoteUsageForAccounts(
  store: OarStore,
  accounts: Array<{ provider: string; profile: string }>,
  opts?: FetchUsageOptions,
): Promise<AccountRemoteUsage[]> {
  // Bound concurrency to avoid bursting provider endpoints.
  const out: AccountRemoteUsage[] = [];
  const queue = [...accounts];
  const workers = Math.min(3, queue.length || 1);
  async function worker() {
    while (queue.length) {
      if (opts?.shouldContinue && !opts.shouldContinue()) return;
      const next = queue.shift();
      if (!next) return;
      out.push(await fetchRemoteUsage(store, next.provider, next.profile, opts));
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
