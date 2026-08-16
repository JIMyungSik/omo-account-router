import { classifyFailure } from "../classifier.ts";
import type { AccountRecord, FailureType } from "../types.ts";
import type { AccountState, CredentialHandle, ProviderAdapter } from "./types.ts";
import type { OarStore } from "../store.ts";

/**
 * Generic adapter for providers OAR vaults but does not (yet) have a
 * dedicated OAuth refresh flow for (e.g. openrouter permanent-ish oauth key,
 * opencode-go / zai-coding-cn api_key providers).
 *
 * healthCheck is limited to local vault presence + oauth expiry metadata —
 * no live network call, no invented refresh. Hot-switch (auth.json slot
 * write) still works because that only requires a stored credential, not a
 * refresh implementation.
 */
export class GenericAdapter implements ProviderAdapter {
  constructor(
    readonly provider: string,
    private readonly store: OarStore,
  ) {}

  async discoverAccounts(): Promise<AccountRecord[]> {
    return this.store.listAccounts(this.provider);
  }

  async healthCheck(account: AccountRecord): Promise<AccountState> {
    const cred = this.store.getVaultCredential(account.provider, account.profile);
    if (!cred) {
      return { auth: "unknown", availability: "REQUIRES_LOGIN", reason: "missing_vault_credential" };
    }
    if (cred.type === "oauth" && Date.now() >= cred.expires) {
      return { auth: "expired", availability: "AUTH_EXPIRED", reason: "access_expired" };
    }
    return {
      auth: account.auth,
      availability: account.availability === "AUTH_REVOKED" ? "AUTH_REVOKED" : "AVAILABLE",
    };
  }

  async resolveCredential(account: AccountRecord): Promise<CredentialHandle> {
    return {
      profile: account.profile,
      ref: account.credentialRef,
      credential: this.store.getVaultCredential(account.provider, account.profile),
    };
  }

  // No executeRefresh: this provider has no known OAuth refresh flow. Do not
  // invent one — daemon's `refresh` action returns "no refresh adapter" for it.

  classifyFailure(result: unknown): FailureType {
    if (result && typeof result === "object") {
      const r = result as { status?: number; body?: string; code?: string };
      return classifyFailure({ provider: this.provider, status: r.status, body: r.body, code: r.code });
    }
    return classifyFailure({ provider: this.provider, body: String(result) });
  }

  supportsHotSwitch(): boolean {
    return true;
  }

  supportsAutoFailover(): boolean {
    return false;
  }

  supportsUsageQuery(): boolean {
    return false;
  }

  supportsConcurrentAccounts(): boolean {
    return false;
  }
}
