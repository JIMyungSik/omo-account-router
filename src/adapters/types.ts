import type { AccountRecord, FailureType, StoredCredential } from "../types.ts";

export type AccountState = {
  auth: AccountRecord["auth"];
  availability: AccountRecord["availability"];
  reason?: string;
  until?: string | null;
};

export type CredentialHandle = {
  profile: string;
  // Prefer refs; raw only for activator internal path
  ref: string;
  credential?: StoredCredential;
};

export type RefreshResult = {
  credential: StoredCredential;
};

/**
 * Best-effort network reachability probe. Intentionally does NOT drive
 * router/account state — an unexpected endpoint/status should never silently
 * mark a working account as revoked. `oar test --live` only prints this for
 * human judgment; local `healthCheck` remains the source of truth for routing.
 */
export type LiveCheckResult = {
  reachable: boolean;
  status?: number;
  detail?: string;
};

export interface ProviderAdapter {
  provider: string;
  discoverAccounts(): Promise<AccountRecord[]>;
  healthCheck(account: AccountRecord): Promise<AccountState>;
  resolveCredential(account: AccountRecord): Promise<CredentialHandle>;
  executeRefresh?(account: AccountRecord, credential: StoredCredential): Promise<RefreshResult>;
  /** Optional live network probe. Skips gracefully (reachable:false) when offline. */
  liveCheck?(account: AccountRecord, credential: StoredCredential): Promise<LiveCheckResult>;
  classifyFailure(result: unknown): FailureType;
  supportsHotSwitch(): boolean;
  supportsAutoFailover(): boolean;
  supportsUsageQuery(): boolean;
  supportsConcurrentAccounts(): boolean;
}
