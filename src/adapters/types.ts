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

export interface ProviderAdapter {
  provider: string;
  discoverAccounts(): Promise<AccountRecord[]>;
  healthCheck(account: AccountRecord): Promise<AccountState>;
  resolveCredential(account: AccountRecord): Promise<CredentialHandle>;
  executeRefresh?(account: AccountRecord, credential: StoredCredential): Promise<RefreshResult>;
  classifyFailure(result: unknown): FailureType;
  supportsHotSwitch(): boolean;
  supportsAutoFailover(): boolean;
  supportsUsageQuery(): boolean;
  supportsConcurrentAccounts(): boolean;
}
