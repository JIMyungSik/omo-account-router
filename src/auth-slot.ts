import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createSenpiAuthStorage } from "./senpi-auth.ts";
import type { OarStore } from "./store.ts";
import type { ProfileId, ProviderId, StoredCredential } from "./types.ts";
import { resolveActiveAuthPaths } from "./paths.ts";

/**
 * Activates an OAR vault credential into Senpi/OMO auth.json provider slot(s).
 *
 * Why this enables hot switch without OMO restart:
 * Senpi AuthStorage.readLatestData() compares file revision
 * (`dev:ino:size:mtimeNs:ctimeNs`) and reloads on change.
 * ModelRuntime.stream → prepareRequest → getAuth runs per request and builds a
 * fresh xAI OpenAI client (not a singleton).
 *
 * Reboot / refresh safety:
 * Senpi persists OAuth refresh results only into live auth.json. OAR vault does
 * not see that write. resolve→ensureActivated must NOT clobber a fresher live
 * token with a stale vault copy (that revokes the rotated refresh → invalid_grant).
 * Instead: pull vault up from live when live is a newer same-lineage credential;
 * push vault→live only for profile drift or a fresher vault.
 */
export class AuthSlotActivator {
  private readonly store: OarStore;
  private readonly authPaths: string[];
  private readonly preferSenpiLock: boolean;

  constructor(opts: { store: OarStore; authPaths?: string[]; preferSenpiLock?: boolean }) {
    this.store = opts.store;
    this.authPaths = opts.authPaths ?? resolveActiveAuthPaths();
    this.preferSenpiLock = opts.preferSenpiLock ?? true;
  }

  getAuthPaths(): string[] {
    return [...this.authPaths];
  }

  async activate(provider: ProviderId, profile: ProfileId): Promise<{ paths: string[]; via: string }> {
    const cred = this.store.getVaultCredential(provider, profile);
    if (!cred) {
      throw new Error(`No vault credential for ${provider}/${profile}`);
    }
    const written: string[] = [];
    let via = "atomic-rename";
    for (const path of this.authPaths) {
      const usedSenpi = this.preferSenpiLock ? await this.writeSlotViaSenpi(path, provider, cred) : false;
      if (!usedSenpi) this.writeSlot(path, provider, cred);
      else via = "senpi-auth-storage";
      written.push(path);
    }
    this.markProfileActive(provider, profile);
    return { paths: written, via };
  }

  /**
   * Keep live auth.json aligned with the preferred vault profile without
   * destroying a newer Senpi OAuth refresh already written to live.
   */
  async ensureActivated(
    provider: ProviderId,
    profile: ProfileId,
  ): Promise<{ paths: string[]; via: string; skipped: boolean }> {
    const cred = this.store.getVaultCredential(provider, profile);
    if (!cred) throw new Error(`No vault credential for ${provider}/${profile}`);

    let sawMissing = false;
    let sawOtherKnownProfile = false;
    let fresherLive: StoredCredential | undefined;

    for (const path of this.authPaths) {
      if (!existsSync(path)) {
        sawMissing = true;
        continue;
      }
      let live: StoredCredential | undefined;
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredCredential>;
        live = data[provider];
      } catch {
        sawMissing = true;
        continue;
      }
      if (!live) {
        sawMissing = true;
        continue;
      }
      // Identity = access/refresh/key (ignore expires noise from clock skew).
      if (credentialsSameIdentity(live, cred)) {
        continue;
      }
      if (this.matchesOtherVaultProfile(provider, profile, live)) {
        sawOtherKnownProfile = true;
        continue;
      }
      if (isFresherOAuth(live, cred)) {
        // Prefer the freshest live credential across paths.
        if (!fresherLive || isFresherOAuth(live, fresherLive)) {
          fresherLive = live;
        }
        continue;
      }
      // Mismatch where vault is same-or-newer, or non-oauth drift → push vault.
      sawMissing = true;
    }

    if (fresherLive && !sawOtherKnownProfile) {
      this.store.putVaultCredential(provider, profile, fresherLive);
      this.markProfileActive(provider, profile);
      // Re-read: after pull-up, all paths may still differ from each other; write vault→all.
      const act = await this.activate(provider, profile);
      return { ...act, via: `${act.via}+vault-pull-up`, skipped: false };
    }

    if (!sawMissing && !sawOtherKnownProfile && !fresherLive) {
      return { paths: [...this.authPaths], via: "already-matched", skipped: true };
    }

    const act = await this.activate(provider, profile);
    return {
      ...act,
      via: sawOtherKnownProfile ? `${act.via}+profile-realign` : act.via,
      skipped: false,
    };
  }

  private matchesOtherVaultProfile(
    provider: ProviderId,
    profile: ProfileId,
    live: StoredCredential,
  ): boolean {
    for (const other of this.store.listAccounts(provider)) {
      if (other.profile === profile) continue;
      const otherCred = this.store.getVaultCredential(provider, other.profile);
      if (otherCred && credentialsSameIdentity(live, otherCred)) return true;
    }
    return false;
  }

  private markProfileActive(provider: ProviderId, profile: ProfileId): void {
    const account = this.store.getAccount(provider, profile);
    for (const other of this.store.listAccounts(provider)) {
      if (other.profile === profile) continue;
      if (other.availability === "ACTIVE") {
        this.store.upsertAccount({
          ...other,
          availability: "AVAILABLE",
        });
      }
    }
    if (account) {
      this.store.upsertAccount({
        ...account,
        lastUsedAt: new Date().toISOString(),
        availability: "ACTIVE",
      });
    }
  }

  private async writeSlotViaSenpi(
    authPath: string,
    provider: ProviderId,
    credential: StoredCredential,
  ): Promise<boolean> {
    try {
      const storage = await createSenpiAuthStorage(authPath);
      if (!storage) return false;
      await storage.modify(provider, async () => credential);
      return true;
    } catch {
      return false;
    }
  }

  private writeSlot(authPath: string, provider: ProviderId, credential: StoredCredential): void {
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    let data: Record<string, unknown> = {};
    if (existsSync(authPath)) {
      try {
        data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    // Preserve other providers; replace only the target provider slot.
    data[provider] = credential;
    const tmp = `${authPath}.oar.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, authPath);
    try {
      chmodSync(authPath, 0o600);
    } catch {
      // ignore
    }
  }
}

/** Exact credential equality including expires (tests / strict compare). */
export function credentialsEqual(a: StoredCredential, b: StoredCredential): boolean {
  if (!credentialsSameIdentity(a, b)) return false;
  if (a.type === "oauth" && b.type === "oauth") return a.expires === b.expires;
  return true;
}

/**
 * Same secrets/identity for slot ownership. Ignores expires so a known vault
 * profile is still recognized after clock-skewed copies in live auth.json.
 */
export function credentialsSameIdentity(a: StoredCredential, b: StoredCredential): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "api_key" && b.type === "api_key") {
    return a.key === b.key;
  }
  if (a.type === "oauth" && b.type === "oauth") {
    return (
      a.access === b.access &&
      a.refresh === b.refresh &&
      (a.accountId ?? undefined) === (b.accountId ?? undefined)
    );
  }
  return false;
}

/**
 * True when `candidate` looks like a newer OAuth credential than `baseline`
 * (typical Senpi access-token refresh of the same account lineage).
 */
export function isFresherOAuth(candidate: StoredCredential, baseline: StoredCredential): boolean {
  if (candidate.type !== "oauth" || baseline.type !== "oauth") return false;
  if (
    candidate.accountId &&
    baseline.accountId &&
    candidate.accountId !== baseline.accountId
  ) {
    return false;
  }
  if (credentialsSameIdentity(candidate, baseline) && candidate.expires === baseline.expires) {
    return false;
  }
  return candidate.expires > baseline.expires;
}
