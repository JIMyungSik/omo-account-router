import { subjectFromCredential } from "./credential-identity.ts";
import { readCredentialFromAuthJson } from "./import-all.ts";
import type { OarStore } from "./store.ts";
import type { StoredCredential } from "./types.ts";

export type XaiReloginHealCandidate = {
  readonly authPath: string;
  readonly profile: string;
  readonly credential: StoredCredential;
};

export function findXaiReloginHealCandidate(
  store: OarStore,
  authPaths: readonly string[],
  now = Date.now(),
): XaiReloginHealCandidate | undefined {
  const preferred = store.getState().providers.xai?.preferred;
  if (!preferred) return undefined;

  const vault = store.getVaultCredential("xai", preferred);
  const vaultSubject = subjectFromCredential(vault);
  if (!vaultSubject) return undefined;

  for (const authPath of authPaths) {
    let primary: StoredCredential;
    let latest: StoredCredential;
    try {
      primary = readCredentialFromAuthJson(authPath, "xai", { account: "primary" });
      latest = readCredentialFromAuthJson(authPath, "xai", { account: "latest" });
    } catch (error) {
      if (error instanceof Error) continue;
      throw error;
    }
    if (primary.type !== "oauth" || latest.type !== "oauth") continue;

    const primarySubject = subjectFromCredential(primary);
    const latestSubject = subjectFromCredential(latest);
    if (
      !primarySubject ||
      primarySubject !== latestSubject ||
      latestSubject !== vaultSubject ||
      latest.expires <= primary.expires ||
      latest.expires <= now + 5 * 60 * 1000 ||
      latest.refresh === primary.refresh
    ) {
      continue;
    }
    return { authPath, profile: preferred, credential: latest };
  }
  return undefined;
}
