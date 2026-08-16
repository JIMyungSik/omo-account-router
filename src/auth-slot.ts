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
    const account = this.store.getAccount(provider, profile);
    // Only one profile per provider should look ACTIVE in status.
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
    return { paths: written, via };
  }


  /**
   * Activate only when the live auth.json slot does not already match the
   * vault credential for this profile. Prevents silent drift back to another
   * profile (e.g. exhausted main) written by an external process.
   */
  async ensureActivated(
    provider: ProviderId,
    profile: ProfileId,
  ): Promise<{ paths: string[]; via: string; skipped: boolean }> {
    const cred = this.store.getVaultCredential(provider, profile);
    if (!cred) throw new Error(`No vault credential for ${provider}/${profile}`);
    let mismatched = false;
    for (const path of this.authPaths) {
      if (!existsSync(path)) {
        mismatched = true;
        break;
      }
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredCredential>;
        const live = data[provider];
        if (!live || live.type !== cred.type) {
          mismatched = true;
          break;
        }
        if (cred.type === "oauth" && live.type === "oauth") {
          if (live.access !== cred.access || live.refresh !== cred.refresh) {
            mismatched = true;
            break;
          }
        } else if (cred.type === "api_key" && live.type === "api_key") {
          if (live.key !== cred.key) {
            mismatched = true;
            break;
          }
        }
      } catch {
        mismatched = true;
        break;
      }
    }
    if (!mismatched) return { paths: [...this.authPaths], via: "already-matched", skipped: true };
    const act = await this.activate(provider, profile);
    return { ...act, skipped: false };
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
