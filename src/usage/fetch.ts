import { defaultOarRoot } from "../paths.ts";
import type { OarStore } from "../store.ts";
import { getCachedUsage, putCachedUsage } from "./cache.ts";
import { fetchCodexUsage } from "./codex.ts";
import type { AccountRemoteUsage } from "./types.ts";
import { fetchXaiGrokSubscriptionUsage } from "./xai-grok.ts";

export type FetchUsageOptions = {
  root?: string;
  /** Skip network when cache younger than this (ms). Default 60s. */
  maxAgeMs?: number;
  /** Force network refresh */
  force?: boolean;
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
    putCachedUsage(miss, root);
    return miss;
  }

  let result: AccountRemoteUsage;
  if (provider === "openai-codex") {
    result = await fetchCodexUsage(provider, profile, cred, { fetchImpl: opts?.fetchImpl });
  } else if (provider === "xai") {
    result = await fetchXaiGrokSubscriptionUsage(provider, profile, cred, {
      fetchImpl: opts?.fetchImpl,
    });
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

  putCachedUsage(result, root);
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
      const next = queue.shift();
      if (!next) return;
      out.push(await fetchRemoteUsage(store, next.provider, next.profile, opts));
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
