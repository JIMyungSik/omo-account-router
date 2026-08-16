import type { OarStore } from "./store.ts";
import type {
  AccountAvailability,
  AccountRecord,
  FailureType,
  ProfileId,
  ProviderId,
  ReportRequest,
  ResolveRequest,
  ResolveResponse,
} from "./types.ts";
import { isAccountFailoverCandidate } from "./classifier.ts";

const ELIGIBLE: AccountAvailability[] = ["AVAILABLE", "ACTIVE"];

function isEligible(a: AccountRecord, now = Date.now()): boolean {
  if (a.disabled) return false;
  if (a.auth === "revoked") return false;
  if (
    a.availability === "AUTH_REVOKED" ||
    a.availability === "REQUIRES_LOGIN" ||
    a.availability === "DISABLED"
  ) {
    return false;
  }
  if (
    (a.availability === "COOLDOWN" ||
      a.availability === "RATE_LIMITED" ||
      a.availability === "QUOTA_EXHAUSTED") &&
    a.until
  ) {
    if (Date.parse(a.until) > now) return false;
  } else if (
    a.availability === "COOLDOWN" ||
    a.availability === "RATE_LIMITED" ||
    a.availability === "QUOTA_EXHAUSTED" ||
    a.availability === "AUTH_EXPIRED"
  ) {
    return false;
  }
  return ELIGIBLE.includes(a.availability) || a.availability === "UNKNOWN";
}

export class OarRouter {
  constructor(private readonly store: OarStore) {}

  resolve(req: ResolveRequest): ResolveResponse {
    const policy = this.store.getProviderPolicy(req.provider);
    const accounts = this.store.listAccounts(req.provider);

    if (accounts.length === 0) {
      return {
        provider: req.provider,
        profile: "",
        status: "unavailable",
        availability: "UNKNOWN",
        reason: "no_accounts",
      };
    }

    if (policy.mode === "manual" && policy.preferred) {
      const preferred = accounts.find((a) => a.profile === policy.preferred);
      if (preferred && isEligible(preferred)) {
        return this.toResponse(preferred);
      }
      if (preferred && !policy.autoFailover) {
        return {
          provider: req.provider,
          profile: preferred.profile,
          status: "unavailable",
          availability: preferred.availability,
          reason: preferred.reason ?? preferred.availability,
        };
      }
    }

    const eligible = accounts
      .filter((a) => isEligible(a))
      .sort((a, b) => {
        if (policy.preferred) {
          if (a.profile === policy.preferred) return -1;
          if (b.profile === policy.preferred) return 1;
        }
        if (a.priority !== b.priority) return a.priority - b.priority;
        const au = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
        const bu = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
        return au - bu;
      });

    const pick = eligible[0];
    if (!pick) {
      const anyRevoked = accounts.every(
        (a) => a.availability === "AUTH_REVOKED" || a.availability === "REQUIRES_LOGIN",
      );
      return {
        provider: req.provider,
        profile: policy.preferred ?? accounts[0]?.profile ?? "",
        status: "unavailable",
        availability: anyRevoked ? "REQUIRES_LOGIN" : "UNKNOWN",
        reason: "no_eligible_accounts",
      };
    }
    return this.toResponse(pick);
  }

  use(provider: ProviderId, profile: ProfileId): ResolveResponse {
    const account = this.store.getAccount(provider, profile);
    if (!account) {
      throw new Error(`Unknown account ${provider}/${profile}`);
    }
    this.store.setPreferred(provider, profile);
    // touch lastUsed metadata
    this.store.upsertAccount({
      ...account,
      lastUsedAt: new Date().toISOString(),
    });
    return this.resolve({ provider });
  }

  setMode(provider: ProviderId, mode: "auto" | "manual"): void {
    this.store.setProviderMode(provider, mode);
  }

  reportResult(req: ReportRequest): AccountRecord | undefined {
    const account = this.store.getAccount(req.provider, req.account);
    if (!account) return undefined;

    if (req.result === "SUCCESS") {
      const next: AccountRecord = {
        ...account,
        auth: "valid",
        availability: "AVAILABLE",
        reason: undefined,
        until: null,
        lastChecked: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };
      this.store.upsertAccount(next);
      return next;
    }

    const failure = req.result as FailureType;
    const next = { ...account, lastChecked: new Date().toISOString(), reason: req.detail ?? failure };

    switch (failure) {
      case "AUTH_REVOKED":
        next.auth = "revoked";
        next.availability = "AUTH_REVOKED";
        break;
      case "AUTH_EXPIRED":
        next.auth = "expired";
        next.availability = "AUTH_EXPIRED";
        break;
      case "RATE_LIMITED":
        next.availability = "RATE_LIMITED";
        next.until = req.retryAfterSec
          ? new Date(Date.now() + req.retryAfterSec * 1000).toISOString()
          : null;
        break;
      case "QUOTA_EXHAUSTED":
        next.availability = "QUOTA_EXHAUSTED";
        next.until = req.retryAfterSec
          ? new Date(Date.now() + req.retryAfterSec * 1000).toISOString()
          : null;
        break;
      default:
        // non-account failures: leave routing state alone
        this.store.upsertAccount(next);
        return next;
    }

    this.store.upsertAccount(next);

    // Auto-failover only when explicitly enabled for provider (policy-safe default off).
    const policy = this.store.getProviderPolicy(req.provider);
    if (policy.autoFailover && isAccountFailoverCandidate(failure) && policy.mode === "auto") {
      // next resolve() will skip ineligible
    }
    return next;
  }

  private toResponse(account: AccountRecord): ResolveResponse {
    return {
      provider: account.provider,
      profile: account.profile,
      status: "available",
      availability: account.availability,
      credentialRef: account.credentialRef,
    };
  }
}
