import { readFileSync } from "node:fs";
import type { OarClient } from "./client.ts";
import type { StoredCredential } from "./types.ts";

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type === "oauth") {
    return typeof v.access === "string" && typeof v.refresh === "string" && typeof v.expires === "number";
  }
  if (v.type === "api_key") {
    return typeof v.key === "string";
  }
  return false;
}

/**
 * Reads every provider slot out of a Senpi/OMO auth.json. Malformed entries
 * are skipped (never thrown) so one bad slot can't block importing the rest.
 * Never logs credential contents.
 */
export function readAllCredentialsFromAuthJson(authPath: string): Record<string, StoredCredential> {
  const raw = readFileSync(authPath, "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, StoredCredential> = {};
  for (const [provider, value] of Object.entries(data)) {
    if (isStoredCredential(value)) {
      out[provider] = value;
    }
  }
  return out;
}

export type ImportAllOptions = {
  from: string;
  profile: string;
  /** When false (default), providers that already have a vault credential for `profile` are skipped. */
  force: boolean;
};

export type ImportAllResult = {
  imported: string[];
  skipped: string[];
  errors: Array<{ provider: string; error: string }>;
};

/**
 * Imports every provider slot found in `opts.from` into the OAR vault under
 * `opts.profile`, via the daemon's existing `import-credential` action. By
 * default this never overwrites a provider/profile that already has a vault
 * credential — pass `force: true` to overwrite.
 */
export async function importAllFromAuthJson(client: OarClient, opts: ImportAllOptions): Promise<ImportAllResult> {
  const credentials = readAllCredentialsFromAuthJson(opts.from);
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ provider: string; error: string }> = [];

  for (const [provider, credential] of Object.entries(credentials)) {
    if (!opts.force) {
      const existing = await client.request({
        protocol: 1,
        action: "test",
        provider,
        profile: opts.profile,
      });
      if (existing.ok) {
        const data = existing.data as { availability?: string };
        if (data.availability && data.availability !== "REQUIRES_LOGIN") {
          skipped.push(provider);
          continue;
        }
      }
    }
    const res = await client.request({
      protocol: 1,
      action: "import-credential",
      provider,
      profile: opts.profile,
      credential,
    });
    if (res.ok) imported.push(provider);
    else errors.push({ provider, error: res.error });
  }

  return { imported, skipped, errors };
}
