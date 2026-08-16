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
    if (account) {
      this.store.upsertAccount({
        ...account,
        lastUsedAt: new Date().toISOString(),
        availability: "ACTIVE",
      });
    }
    return { paths: written, via };
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
