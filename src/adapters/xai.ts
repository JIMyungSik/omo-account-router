import { classifyFailure } from "../classifier.ts";
import type { AccountRecord, FailureType, StoredCredential } from "../types.ts";
import type { AccountState, CredentialHandle, LiveCheckResult, ProviderAdapter, RefreshResult } from "./types.ts";
import type { OarStore } from "../store.ts";

/** Public OAuth client id from installed senpi pi-ai xai.js — not a secret. */
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/**
 * xAI / Grok adapter.
 * Auto-failover default OFF (policy-safe). Hot manual switch via auth.json slot.
 * OAuth refresh is daemon-mediated under AccountRefreshLock.
 */
export class XaiAdapter implements ProviderAdapter {
  readonly provider = "xai";

  constructor(private readonly store: OarStore) {}

  async discoverAccounts(): Promise<AccountRecord[]> {
    return this.store.listAccounts("xai");
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
    const credential = this.store.getVaultCredential(account.provider, account.profile);
    return {
      profile: account.profile,
      ref: account.credentialRef,
      credential,
    };
  }

  async executeRefresh(account: AccountRecord, credential: StoredCredential): Promise<RefreshResult> {
    if (credential.type !== "oauth") {
      throw new Error("xAI refresh requires oauth credential");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_CLIENT_ID,
      refresh_token: credential.refresh,
    });
    const response = await fetch(XAI_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    let parsed: Record<string, unknown> = {};
    try {
      const json: unknown = await response.json();
      parsed = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
    } catch {
      throw new Error(`xAI OAuth token refresh failed (HTTP ${response.status}): invalid JSON`);
    }
    if (!response.ok) {
      const error = typeof parsed.error === "string" ? parsed.error : undefined;
      const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined;
      const detail = [error, description].filter(Boolean).join(": ");
      const err = new Error(
        `xAI OAuth token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
      (err as Error & { status?: number; body?: string }).status = response.status;
      (err as Error & { status?: number; body?: string }).body = detail;
      throw err;
    }
    const access = parsed.access_token;
    if (typeof access !== "string" || access.length === 0) {
      throw new Error("Invalid xAI OAuth response field: access_token");
    }
    const refresh =
      parsed.refresh_token === undefined ? credential.refresh : parsed.refresh_token;
    if (typeof refresh !== "string" || refresh.length === 0) {
      throw new Error("Invalid xAI OAuth response field: refresh_token");
    }
    const expiresInSeconds =
      parsed.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : Number(parsed.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error("Invalid xAI OAuth response field: expires_in");
    }
    return {
      credential: {
        type: "oauth",
        access,
        refresh,
        expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
      },
    };
  }

  /**
   * Best-effort connectivity probe (OpenAI-compatible `/v1/models` list).
   * Does not mutate router state — see LiveCheckResult doc.
   */
  async liveCheck(_account: AccountRecord, credential: StoredCredential): Promise<LiveCheckResult> {
    const token = credential.type === "oauth" ? credential.access : credential.key;
    try {
      const response = await fetch("https://api.x.ai/v1/models", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      return { reachable: true, status: response.status };
    } catch (error) {
      return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  classifyFailure(result: unknown): FailureType {
    if (result && typeof result === "object") {
      const r = result as { status?: number; body?: string; code?: string };
      return classifyFailure({ provider: "xai", status: r.status, body: r.body, code: r.code });
    }
    return classifyFailure({ provider: "xai", body: String(result) });
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
    // Single auth.json slot is process-wide; concurrent *different* accounts
    // of the same provider are not supported without per-request header injection.
    return false;
  }
}
