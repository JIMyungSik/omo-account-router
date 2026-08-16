import type { StoredCredential } from "../types.ts";
import type { AccountRemoteUsage, UsageWindow } from "./types.ts";

/** Grok Build / SuperGrok subscription billing (works with OAR xAI OAuth access tokens). */
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

function remaining(used: number | null | undefined): number | null {
  if (used == null || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10));
}

/**
 * Fetch Grok subscription credit usage for an xAI OAuth vault credential.
 * Verified against live OAR vault tokens (not the separate Management API prepaid path).
 */
export async function fetchXaiGrokSubscriptionUsage(
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
      source: "grok-billing",
      fetchedAt,
      ok: false,
      error: "xai grok subscription usage requires oauth credential",
      windows: [],
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
        "User-Agent": "GrokCLI/1.0.4",
      },
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
        source: "grok-billing",
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
        source: "grok-billing",
        fetchedAt,
        ok: false,
        error: `HTTP ${response.status}`,
        windows: [],
      };
    }

    const config = (data.config && typeof data.config === "object" ? data.config : data) as Record<
      string,
      unknown
    >;
    const usedRaw = config.creditUsagePercent;
    const used = typeof usedRaw === "number" && Number.isFinite(usedRaw) ? usedRaw : null;
    const period = config.currentPeriod;
    let resetsAt: string | null = null;
    let windowSeconds: number | null = null;
    let periodType: string | undefined;
    if (period && typeof period === "object") {
      const p = period as Record<string, unknown>;
      periodType = typeof p.type === "string" ? p.type : undefined;
      if (typeof p.end === "string") resetsAt = p.end;
      if (typeof p.start === "string" && typeof p.end === "string") {
        const ms = Date.parse(p.end) - Date.parse(p.start);
        if (Number.isFinite(ms) && ms > 0) windowSeconds = Math.round(ms / 1000);
      }
    }
    if (!resetsAt && typeof config.billingPeriodEnd === "string") {
      resetsAt = config.billingPeriodEnd;
    }

    const kind: UsageWindow["kind"] =
      periodType?.includes("WEEKLY") || (windowSeconds != null && windowSeconds >= 6 * 24 * 3600)
        ? "weekly"
        : "period";

    const windows: UsageWindow[] = [
      {
        kind,
        usedPercent: used,
        remainingPercent: remaining(used),
        resetsAt,
        windowSeconds,
        label: "grok",
        limitReached: used != null && used >= 100,
      },
    ];

    const productUsage = config.productUsage;
    if (Array.isArray(productUsage)) {
      for (const row of productUsage) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const product = typeof r.product === "string" ? r.product : "product";
        const pu = typeof r.usagePercent === "number" ? r.usagePercent : null;
        if (product.toLowerCase() === "grokbuild" && pu === used) continue;
        windows.push({
          kind: "other",
          usedPercent: pu,
          remainingPercent: remaining(pu),
          resetsAt,
          label: product,
          limitReached: pu != null && pu >= 100,
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
        prepaidBalance: (config.prepaidBalance as { val?: number } | undefined)?.val,
      },
    };
  } catch (error) {
    return {
      provider,
      profile,
      source: "grok-billing",
      fetchedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      windows: [],
    };
  }
}
