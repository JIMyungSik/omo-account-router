import { classifyFailure } from "../classifier.ts";
import type { AccountRecord, FailureType, StoredCredential } from "../types.ts";
import type { AccountState, CredentialHandle, ProviderAdapter, RefreshResult } from "./types.ts";
import type { OarStore } from "../store.ts";

/**
 * OpenAI Codex slot in Senpi auth.json is provider id `openai-codex`.
 * Hot-switch via auth.json works for the next HTTP request. In-process
 * websocketSessionCache is keyed by sessionId+accountId and may keep an old
 * socket until idle TTL — documented limitation, not a Grok blocker.
 */
export class OpenaiCodexAdapter implements ProviderAdapter {
  readonly provider = "openai-codex";

  constructor(private readonly store: OarStore) {}

  async discoverAccounts(): Promise<AccountRecord[]> {
    return this.store.listAccounts("openai-codex");
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

  async executeRefresh(_account: AccountRecord, _credential: StoredCredential): Promise<RefreshResult> {
    throw new Error("openai-codex OAuth refresh is still Senpi-managed; OAR hot-switch uses auth.json slot");
  }

  classifyFailure(result: unknown): FailureType {
    if (result && typeof result === "object") {
      const r = result as { status?: number; body?: string; code?: string };
      return classifyFailure({ provider: "openai-codex", status: r.status, body: r.body, code: r.code });
    }
    return classifyFailure({ provider: "openai-codex", body: String(result) });
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
