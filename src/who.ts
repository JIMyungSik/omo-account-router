import { existsSync, readFileSync } from "node:fs";
import { credentialsSameSecrets } from "./auth-slot.ts";
import { loginFromCredential } from "./credential-identity.ts";
import { resolveProvider } from "./provider-alias.ts";
import type { AccountRecord, StoredCredential } from "./types.ts";

export type LiveAccountView = {
  readonly path: string;
  readonly provider: string;
  readonly profile: string;
  readonly login: string;
  readonly slot: string;
  readonly note: string;
};

function isCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "oauth" || type === "api_key";
}

function sameAccount(live: StoredCredential, vault: StoredCredential): boolean {
  if (credentialsSameSecrets(live, vault)) return true;
  return live.type === "oauth" && vault.type === "oauth" && Boolean(live.refresh) && live.refresh === vault.refresh;
}

function slotName(slot: StoredCredential): string {
  const accounts = (slot as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return "-";
  for (const item of accounts) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    const access = (item as { access?: unknown }).access;
    const refresh = (item as { refresh?: unknown }).refresh;
    const key = (item as { key?: unknown }).key;
    if (slot.type === "oauth" && (access === slot.access || refresh === slot.refresh)) return name;
    if (slot.type === "api_key" && key === slot.key) return name;
  }
  return "-";
}

export function describeLiveAuth(
  paths: readonly string[],
  accounts: readonly AccountRecord[],
  readVault: (provider: string, profile: string) => StoredCredential | undefined,
): LiveAccountView[] {
  const rows: LiveAccountView[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      data = parsed as Record<string, unknown>;
    } catch {
      rows.push({ path, provider: "-", profile: "-", login: "-", slot: "-", note: "unreadable" });
      continue;
    }
    for (const [provider, raw] of Object.entries(data)) {
      if (!isCredential(raw)) continue;
      const canonical = resolveProvider(provider);
      const match = accounts.find((account) => {
        if (resolveProvider(account.provider) !== canonical) return false;
        const vault = readVault(account.provider, account.profile);
        return vault ? sameAccount(raw, vault) : false;
      });
      const login = loginFromCredential(raw) ?? match?.login ?? "-";
      const slot = slotName(raw);
      rows.push({
        path,
        provider,
        profile: match?.profile ?? "-",
        login,
        slot,
        note: match ? "live token" : "no vault match",
      });
    }
  }
  return rows;
}

export function formatWho(rows: readonly LiveAccountView[]): string {
  if (rows.length === 0) return "no live auth slots";
  const lines = ["PATH  PROVIDER  OAR  LOGIN  SLOT  NOTE"];
  for (const row of rows) {
    lines.push(
      [row.path, row.provider, row.profile, row.login, row.slot, row.note].join("  "),
    );
  }
  lines.push("");
  lines.push("OAR is the vault profile whose token is in the file. SLOT is the Senpi accounts[] name only when that entry holds the same token. The footer @login-N is a per-session label and can differ.");
  return lines.join("\n");
}
