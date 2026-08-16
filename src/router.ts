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

/** Accounts that must never be selected for resolve/auto (and default use). */
export function isEligible(a: AccountRecord, now = Date.now()): boolean {
  if (a.disabled) return false;
  if (a.auth === "revoked") return false;
  if (
    a.availability === "AUTH_REVOKED" ||
    a.availability === "REQUIRES_LOGIN" ||
    a.availability === "DISABLED"
  ) {
    return false;
  }
  // Quota exhausted stays blocked until availability is cleared (usage recover / manual force).
  if (a.availability === "QUOTA_EXHAUSTED") {
    return false;
  }
  if ((a.availability === "COOLDOWN" || a.availability === "RATE_LIMITED") && a.until) {
    if (Date.parse(a.until) > now) return false;
  } else if (
    a.availability === "COOLDOWN" ||
    a.availability === "RATE_LIMITED" ||
    a.availability === "AUTH_EXPIRED"
  ) {
    return false;
  }
  return ELIGIBLE.includes(a.availability) || a.availability === "UNKNOWN";
}

export function refuseReason(account: AccountRecord): string {
  if (account.availability === "QUOTA_EXHAUSTED") {
    return `quota exhausted (0% / limit)${account.until ? `; resets ~ ${account.until}` : ""}`;
  }
  if (account.availability === "RATE_LIMITED") {
    return `rate limited${account.until ? `; until ${account.until}` : ""}`;
  }
  if (account.availability === "AUTH_REVOKED" || account.auth === "revoked") {
    return "auth revoked — re-login required";
  }
  if (account.availability === "AUTH_EXPIRED" || account.auth === "expired") {
    return "auth expired — refresh/login required";
  }
  if (account.disabled || account.availability === "DISABLED") {
    return "account disabled";
  }
  return account.reason ?? account.availability;
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

    if (policy.preferred) {
      const preferred = accounts.find((a) => a.profile === policy.preferred);
      if (preferred && isEligible(preferred)) {
        return this.toResponse(preferred);
      }
      // Manual mode: stick on preferred even if blocked (caller sees unavailable).
      // Auto mode (or autoFailover): fall through to another eligible profile.
      if (
        preferred &&
        !isEligible(preferred) &&
        policy.mode === "manual" &&
        !policy.autoFailover
      ) {
        return {
          provider: req.provider,
          profile: preferred.profile,
          status: "unavailable",
          availability: preferred.availability,
          reason: refuseReason(preferred),
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
      const preferred = policy.preferred
        ? accounts.find((a) => a.profile === policy.preferred)
        : undefined;
      const anyRevoked = accounts.every(
        (a) => a.availability === "AUTH_REVOKED" || a.availability === "REQUIRES_LOGIN",
      );
      return {
        provider: req.provider,
        profile: preferred?.profile ?? accounts[0]?.profile ?? "",
        status: "unavailable",
        availability: preferred?.availability ?? (anyRevoked ? "REQUIRES_LOGIN" : "QUOTA_EXHAUSTED"),
        reason: preferred ? refuseReason(preferred) : "no_eligible_accounts",
      };
    }
    return this.toResponse(pick);
  }

  /**
   * Prefer + mark last used. Refuses exhausted/ineligible profiles unless force=true.
   */
  use(provider: ProviderId, profile: ProfileId, opts?: { force?: boolean }): ResolveResponse {
    const account = this.store.getAccount(provider, profile);
    if (!account) {
      throw new Error(`Unknown account ${provider}/${profile}`);
    }
    if (!opts?.force && !isEligible(account)) {
      throw new Error(
        `REFUSED: ${provider}/${profile} is not usable — ${refuseReason(account)}. ` +
          `Not switching (even if auto is on). Pass force to override.`,
      );
    }
    this.store.setPreferred(provider, profile);
    this.store.upsertAccount({
      ...account,
      lastUsedAt: new Date().toISOString(),
    });
    if (opts?.force) {
      return this.toResponse(this.store.getAccount(provider, profile) ?? account);
    }
    return this.resolve({ provider });
  }

  setMode(provider: ProviderId, mode: "auto" | "manual"): void {
    this.store.setProviderMode(provider, mode);
  }

  reportResult(req: ReportRequest): AccountRecord | undefined {
    const account = this.store.getAccount(req.provider, req.account);
    if (!account) return undefined;

    if (req.result === "SUCCESS") {
      // Do not clear QUOTA_EXHAUSTED on SUCCESS — 403 was previously mis-labeled SUCCESS.
      if (account.availability === "QUOTA_EXHAUSTED") {
        const kept: AccountRecord = {
          ...account,
          lastChecked: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        };
        this.store.upsertAccount(kept);
        return kept;
      }
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
    const next: AccountRecord = {
      ...account,
      lastChecked: new Date().toISOString(),
      reason: req.detail ?? failure,
    };

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
        this.store.upsertAccount(next);
        return next;
    }

    this.store.upsertAccount(next);

    const policy = this.store.getProviderPolicy(req.provider);
    if (policy.autoFailover && isAccountFailoverCandidate(failure) && policy.mode === "auto") {
      // next resolve() skips ineligible
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
