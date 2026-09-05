export type ProviderId = string;
export type ProfileId = string;

export type AccountAvailability =
  | "AVAILABLE"
  | "ACTIVE"
  | "COOLDOWN"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "AUTH_EXPIRED"
  | "AUTH_REVOKED"
  | "REQUIRES_LOGIN"
  | "DISABLED"
  | "UNKNOWN";

export type AuthHealth = "valid" | "expired" | "revoked" | "unknown";

export type ProviderMode = "auto" | "manual";

export type FailureType =
  | "AUTH_EXPIRED"
  | "AUTH_REVOKED"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "NETWORK_ERROR"
  | "SERVER_ERROR"
  | "BAD_REQUEST"
  | "INVALID_ARGUMENT"
  | "MODEL_NOT_FOUND"
  | "PROMPT_ERROR"
  | "TOOL_ERROR"
  | "LOCAL_ERROR"
  | "UNKNOWN";

export type OAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  /** ChatGPT/Codex ID token. Never mint one; import or preserve same-account only. */
  idToken?: string;
};

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type StoredCredential = OAuthCredential | ApiKeyCredential;

export type AccountLease = {
  id: string;
  provider: ProviderId;
  profile: ProfileId;
  holder: string;
  acquiredAt: string;
};

export type AccountRecord = {
  provider: ProviderId;
  profile: ProfileId;
  auth: AuthHealth;
  availability: AccountAvailability;
  priority: number;
  credentialRef: string;
  reason?: string;
  until?: string | null;
  lastChecked?: string;
  lastUsedAt?: string;
  /** Optional provider/account cap. Unset = unlimited (do not invent a number). */
  maxConcurrent?: number;
  disabled?: boolean;
};

export type ProviderPolicy = {
  mode: ProviderMode;
  preferred?: ProfileId;
  /** When false, AUTH_REVOKED etc. mark account but do not auto-pick another. Default false (policy-safe). */
  autoFailover: boolean;
};

export type ResolveRequest = {
  provider: ProviderId;
  model?: string;
  member?: string;
};

export type ResolveResponse = {
  provider: ProviderId;
  profile: ProfileId;
  status: "available" | "unavailable";
  availability: AccountAvailability;
  reason?: string;
  credentialRef?: string;
};

export type ReportRequest = {
  provider: ProviderId;
  account: ProfileId;
  result: FailureType | "SUCCESS";
  retryAfterSec?: number;
  detail?: string;
};

export type OarState = {
  version: 1;
  providers: Record<ProviderId, ProviderPolicy>;
  accounts: AccountRecord[];
  updatedAt: string;
};
