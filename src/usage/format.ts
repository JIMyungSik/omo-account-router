import { formatMarkdownTable } from "../table.ts";
import type { AccountRemoteUsage, UsageWindow } from "./types.ts";

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n}%`;
}

function shortReset(iso?: string | null): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  // local short: MM-DD HH:mm
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function pick(
  windows: UsageWindow[],
  pred: (w: UsageWindow) => boolean,
): UsageWindow | undefined {
  return windows.find(pred);
}

export function formatUsageTable(rows: AccountRemoteUsage[]): string {
  if (rows.length === 0) return "(no usage rows)";

  const table = formatMarkdownTable(
    [
      { key: "provider", header: "PROVIDER" },
      { key: "profile", header: "PROFILE" },
      { key: "ok", header: "OK" },
      { key: "session", header: "5H left", align: "right" },
      { key: "weekly", header: "WK left", align: "right" },
      { key: "grok", header: "GROK left", align: "right" },
      { key: "used", header: "USED", align: "right" },
      { key: "reset", header: "RESET" },
      { key: "source", header: "SOURCE" },
      { key: "note", header: "NOTE" },
    ],
    rows.map((u) => {
      if (!u.ok) {
        return {
          provider: u.provider,
          profile: u.profile,
          ok: "no",
          session: "-",
          weekly: "-",
          grok: "-",
          used: "-",
          reset: "-",
          source: u.source,
          note: u.error ?? "error",
        };
      }

      const session = pick(u.windows, (w) => w.kind === "session");
      const weekly = pick(u.windows, (w) => w.kind === "weekly");
      const grok = pick(
        u.windows,
        (w) => w.label === "grok" || (u.provider === "xai" && (w.kind === "weekly" || w.kind === "period")),
      );

      // Primary used/reset for display
      const primary =
        u.provider === "xai" ? grok : weekly ?? session ?? u.windows[0];

      return {
        provider: u.provider,
        profile: u.profile,
        ok: "yes",
        session: u.provider === "openai-codex" ? fmtPct(session?.remainingPercent) : "-",
        weekly: u.provider === "openai-codex" ? fmtPct(weekly?.remainingPercent) : "-",
        grok: u.provider === "xai" ? fmtPct(grok?.remainingPercent) : "-",
        used: fmtPct(primary?.usedPercent),
        reset: shortReset(primary?.resetsAt),
        source: u.source,
        note: primary?.limitReached ? "LIMIT" : "",
      };
    }),
  );

  return [
    "OAR usage (remaining %)",
    table,
    "",
    "5H = Codex session/short window when exposed; WK = Codex weekly; GROK = xAI Grok subscription credits.",
    "- means the provider did not return that window (common: Codex weekly-only plans).",
  ].join("\n");
}
