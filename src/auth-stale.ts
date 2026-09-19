import type { OarStore } from "./store.ts";
import type { StatusRowView } from "./status-format.ts";

const STALE_CHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** Append vault-expiry / lastChecked hints when AUTH metadata may lag reality. */
export function applyAuthStaleHints(rows: StatusRowView[], store: OarStore): StatusRowView[] {
  const now = Date.now();
  return rows.map((row) => {
    if (row.auth !== "valid") return row;
    const cred = store.getVaultCredential(row.provider, row.profile);
    const hints: string[] = [];

    if (cred?.type === "oauth" && cred.expires <= now) {
      hints.push("AUTH may be stale (access token expired)");
    } else if (row.lastChecked) {
      const checked = Date.parse(row.lastChecked);
      if (Number.isFinite(checked) && now - checked > STALE_CHECK_MS) {
        hints.push("AUTH not re-checked recently");
      }
    }

    if (hints.length === 0) return row;

    const hint = `${hints.join("; ")} · oar test ${row.provider} ${row.profile} --live`;
    const note = row.note ? `${row.note} · ${hint}` : hint;
    return { ...row, note };
  });
}
