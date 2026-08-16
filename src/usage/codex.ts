import type { StoredCredential } from "../types.ts";
import type { AccountRemoteUsage, UsageWindow } from "./types.ts";

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function remaining(used: number | null | undefined): number | null {
  if (used == null || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10));
}

function kindFromSeconds(seconds?: number | null): UsageWindow["kind"] {
  if (seconds == null || !Number.isFinite(seconds)) return "other";
  // <= 6h → session/5h-class rolling window
  if (seconds <= 6 * 3600) return "session";
  // >= 6d → weekly-class
  if (seconds >= 6 * 24 * 3600) return "weekly";
  return "other";
}

function windowFromWham(raw: unknown, label?: string): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const usedRaw = w.used_percent ?? w.usedPercent;
  const used = typeof usedRaw === "number" && Number.isFinite(usedRaw) ? usedRaw : null;
  const secRaw = w.limit_window_seconds ?? w.windowDurationMins;
  let windowSeconds: number | null = null;
  if (typeof w.limit_window_seconds === "number") windowSeconds = w.limit_window_seconds;
  else if (typeof w.windowDurationMins === "number") windowSeconds = w.windowDurationMins * 60;
  const resetAtRaw = w.reset_at ?? w.resetsAt;
  let resetsAt: string | null = null;
  if (typeof resetAtRaw === "number" && Number.isFinite(resetAtRaw)) {
    resetsAt = new Date(resetAtRaw * (resetAtRaw < 1e12 ? 1000 : 1)).toISOString();
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
    limitReached: Boolean(w.limit_reached ?? w.limitReached),
  };
}

/**
 * Fetch Codex plan windows using the ChatGPT WHAM usage endpoint
 * (same family CodexBar documents; works with OAR vault OAuth access tokens).
 *
 * Note: some plans currently expose only a weekly primary window (secondary null).
 * When a shorter session window exists it is mapped to kind=session ("5h").
 */
export async function fetchCodexUsage(
  provider: string,
  profile: string,
  credential: StoredCredential,
  opts?: { fetchImpl?: typeof fetch },
): Promise<AccountRemoteUsage> {
  const fetchedAt = new Date().toISOString();
  if (credential.type !== "oauth") {
    return {
      provider,
      profile,
      source: "codex-wham",
      fetchedAt,
      ok: false,
      error: "codex usage requires oauth credential",
      windows: [],
    };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.access}`,
    Accept: "application/json",
    "User-Agent": "omo-account-router/0.1",
  };
  if (credential.accountId) {
    headers["ChatGPT-Account-Id"] = credential.accountId;
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(WHAM_USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      return {
        provider,
        profile,
        source: "codex-wham",
        fetchedAt,
        ok: false,
        error: `invalid JSON (HTTP ${response.status})`,
        windows: [],
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
        windows: [],
      };
    }

    const windows: UsageWindow[] = [];
    const rateLimit = data.rate_limit;
    if (rateLimit && typeof rateLimit === "object") {
      const rl = rateLimit as Record<string, unknown>;
      const primary = windowFromWham(rl.primary_window);
      if (primary) windows.push(primary);
      const secondary = windowFromWham(rl.secondary_window);
      if (secondary) windows.push(secondary);
    }
    const additional = data.additional_rate_limits;
    if (Array.isArray(additional)) {
      for (const item of additional) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const name = typeof row.limit_name === "string" ? row.limit_name : "extra";
        const nested = row.rate_limit;
        if (nested && typeof nested === "object") {
          const n = nested as Record<string, unknown>;
          const w = windowFromWham(n.primary_window, name);
          if (w) windows.push(w);
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
        limitReached: Boolean(
          rateLimit &&
            typeof rateLimit === "object" &&
            (rateLimit as Record<string, unknown>).limit_reached,
        ),
      },
    };
  } catch (error) {
    return {
      provider,
      profile,
      source: "codex-wham",
      fetchedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      windows: [],
    };
  }
}

export function codexSessionWeek(usage: AccountRemoteUsage): {
  session?: UsageWindow;
  weekly?: UsageWindow;
} {
  const session = usage.windows.find((w) => w.kind === "session");
  const weekly = usage.windows.find((w) => w.kind === "weekly");
  return { session, weekly };
}
