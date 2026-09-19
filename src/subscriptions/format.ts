import { formatMarkdownTable } from "../table.ts";
import type { AuditResult } from "./audit.ts";
import type { SubscriptionPlan } from "./store.ts";

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `$${n.toFixed(0)}`;
}

export function formatSubscriptionsList(plans: SubscriptionPlan[]): string {
  if (plans.length === 0) {
    return "OAR subscriptions\n(no plans configured — oar subscriptions set <provider> <profile> --monthly-usd <n>)";
  }
  const table = formatMarkdownTable(
    [
      { key: "provider", header: "PROVIDER" },
      { key: "profile", header: "PROFILE" },
      { key: "usd", header: "$/MO", align: "right" },
      { key: "plan", header: "PLAN" },
      { key: "cycle", header: "CYCLE DAY", align: "right" },
    ],
    plans.map((p) => ({
      provider: p.provider,
      profile: p.profile,
      usd: fmtUsd(p.monthlyUsd),
      plan: p.planLabel ?? "-",
      cycle: p.billingCycleDay != null ? String(p.billingCycleDay) : "-",
    })),
  );
  const total = plans.reduce((s, p) => s + p.monthlyUsd, 0);
  return ["OAR subscriptions", table, "", `total configured: ${fmtUsd(total)}/mo`, ""].join("\n");
}

export function formatAuditText(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(
    `OAR subscription audit  ·  total configured ${fmtUsd(result.totalConfiguredUsd)}/mo  ·  potential savings ${fmtUsd(result.potentialSavingsUsd)}/mo`,
  );
  lines.push("");
  lines.push(
    formatMarkdownTable(
      [
        { key: "provider", header: "PROVIDER" },
        { key: "profile", header: "PROFILE" },
        { key: "plan", header: "PLAN" },
        { key: "usd", header: "$/MO", align: "right" },
        { key: "usage", header: "USAGE" },
        { key: "status", header: "STATUS" },
        { key: "rec", header: "RECOMMEND" },
        { key: "save", header: "SAVE/MO", align: "right" },
        { key: "note", header: "NOTE" },
      ],
      result.rows.map((r) => ({
        provider: r.provider,
        profile: r.profile,
        plan: r.planLabel,
        usd: fmtUsd(r.monthlyUsd),
        usage: r.usageSummary,
        status: r.status,
        rec: r.recommend,
        save: r.savePerMonth != null ? fmtUsd(r.savePerMonth) : "-",
        note: r.note,
      })),
    ),
  );
  lines.push("");
  lines.push("RECOMMENDATION SUMMARY");
  if (result.summary.keep.length) lines.push(`  keep:     ${result.summary.keep.join(", ")}`);
  if (result.summary.cancel.length) {
    lines.push(`  cancel:   ${result.summary.cancel.join(", ")}`);
  }
  if (result.summary.fix.length) lines.push(`  fix:      ${result.summary.fix.join(", ")}`);
  if (result.summary.demote.length) lines.push(`  demote:   ${result.summary.demote.join(", ")}`);
  if (result.summary.unsetCost.length) {
    lines.push(`  unset:    ${result.summary.unsetCost.join(", ")} (add monthly cost)`);
  }
  lines.push("");
  lines.push("Heuristic only — not financial advice. Provider must keep ≥1 eligible profile.");
  lines.push("  oar subscriptions set <provider> <profile> --monthly-usd <n> [--plan \"…\"]");
  lines.push("  oar doctor   # codex auth remediation");
  return lines.join("\n");
}

export function auditToJson(result: AuditResult): unknown {
  return result;
}
