export type UsageWindowKind = "session" | "weekly" | "period" | "other";

export type UsageWindow = {
  kind: UsageWindowKind;
  /** 0-100 when known */
  usedPercent: number | null;
  /** remaining percent = 100 - used when used known */
  remainingPercent: number | null;
  resetsAt?: string | null;
  windowSeconds?: number | null;
  label?: string;
  limitReached?: boolean;
};

export type AccountRemoteUsage = {
  provider: string;
  profile: string;
  source: string;
  fetchedAt: string;
  ok: boolean;
  error?: string;
  /** Primary plan windows (Codex 5h/week, Grok subscription period, …) */
  windows: UsageWindow[];
  extras?: Record<string, unknown>;
};

export type UsageCacheFile = {
  version: 1;
  updatedAt: string;
  entries: Record<string, AccountRemoteUsage>;
};
