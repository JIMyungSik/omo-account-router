import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultOarRoot } from "../paths.ts";
import type { AccountRemoteUsage, UsageCacheFile } from "./types.ts";

export function usageCachePath(root = defaultOarRoot()): string {
  return join(root, "usage-cache.json");
}

export function cacheKey(provider: string, profile: string): string {
  return `${provider}/${profile}`;
}

export function loadUsageCache(root = defaultOarRoot()): UsageCacheFile {
  const path = usageCachePath(root);
  if (!existsSync(path)) return { version: 1, updatedAt: new Date(0).toISOString(), entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as UsageCacheFile;
    if (parsed?.version !== 1 || !parsed.entries) {
      return { version: 1, updatedAt: new Date(0).toISOString(), entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: {} };
  }
}

export function saveUsageCache(cache: UsageCacheFile, root = defaultOarRoot()): void {
  const path = usageCachePath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const body: UsageCacheFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: cache.entries,
  };
  writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
}

export function getCachedUsage(
  provider: string,
  profile: string,
  opts?: { maxAgeMs?: number; root?: string },
): AccountRemoteUsage | undefined {
  const root = opts?.root ?? defaultOarRoot();
  const maxAgeMs = opts?.maxAgeMs ?? 60_000;
  const cache = loadUsageCache(root);
  const entry = cache.entries[cacheKey(provider, profile)];
  if (!entry) return undefined;
  const age = Date.now() - Date.parse(entry.fetchedAt);
  if (!Number.isFinite(age) || age > maxAgeMs) return undefined;
  return entry;
}

export function putCachedUsage(entry: AccountRemoteUsage, root = defaultOarRoot()): void {
  const cache = loadUsageCache(root);
  cache.entries[cacheKey(entry.provider, entry.profile)] = entry;
  saveUsageCache(cache, root);
}
