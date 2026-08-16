import { classifyFailure } from "../classifier.ts";
import type { AccountRecord, FailureType, StoredCredential } from "../types.ts";
import type { AccountState, CredentialHandle, LiveCheckResult, ProviderAdapter, RefreshResult } from "./types.ts";
import type { OarStore } from "../store.ts";

/**
 * Public OAuth client id decoded from installed senpi pi-ai `anthropic.js`
 * (`decode('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl')`) — not a secret,
 * same class of public client id senpi uses for xAI.
 */
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/** Claude / Anthropic slot in Senpi auth.json is provider id `anthropic`. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic";

  constructor(private readonly store: OarStore) {}

  async discoverAccounts(): Promise<AccountRecord[]> {
    return this.store.listAccounts("anthropic");
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

  async executeRefresh(_account: AccountRecord, credential: StoredCredential): Promise<RefreshResult> {
    if (credential.type !== "oauth") {
      throw new Error("anthropic refresh requires oauth credential");
    }
    const response = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: ANTHROPIC_CLIENT_ID,
        refresh_token: credential.refresh,
      }),
    });
    let parsed: Record<string, unknown> = {};
    try {
      const json: unknown = await response.json();
      parsed = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
    } catch {
      throw new Error(`anthropic OAuth token refresh failed (HTTP ${response.status}): invalid JSON`);
    }
    if (!response.ok) {
      const error = typeof parsed.error === "string" ? parsed.error : undefined;
      const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined;
      const detail = [error, description].filter(Boolean).join(": ");
      const err = new Error(
        `anthropic OAuth token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
      (err as Error & { status?: number; body?: string }).status = response.status;
      (err as Error & { status?: number; body?: string }).body = detail;
      throw err;
    }
    const access = parsed.access_token;
    if (typeof access !== "string" || access.length === 0) {
      throw new Error("Invalid anthropic OAuth response field: access_token");
    }
    const refresh = parsed.refresh_token === undefined ? credential.refresh : parsed.refresh_token;
    if (typeof refresh !== "string" || refresh.length === 0) {
      throw new Error("Invalid anthropic OAuth response field: refresh_token");
    }
    const expiresInSeconds =
      parsed.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : Number(parsed.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error("Invalid anthropic OAuth response field: expires_in");
    }
    return {
      credential: {
        type: "oauth",
        access,
        refresh,
        expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
        ...(credential.accountId ? { accountId: credential.accountId } : {}),
      },
    };
  }

  /**
   * Best-effort connectivity probe (Anthropic `/v1/models`). Anthropic OAuth
   * (Claude Code style) tokens may require the `anthropic-beta` header on
   * some endpoints; a non-2xx here is informational only, not authoritative
   * — does not mutate router state. See LiveCheckResult doc.
   */
  async liveCheck(_account: AccountRecord, credential: StoredCredential): Promise<LiveCheckResult> {
    if (credential.type !== "oauth" && credential.type !== "api_key") {
      return { reachable: false, detail: "unsupported_credential_type" };
    }
    try {
      const response = await fetch("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers:
          credential.type === "oauth"
            ? { Authorization: `Bearer ${credential.access}`, "anthropic-version": "2023-06-01" }
            : { "x-api-key": credential.key, "anthropic-version": "2023-06-01" },
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
      return classifyFailure({ provider: "anthropic", status: r.status, body: r.body, code: r.code });
    }
    return classifyFailure({ provider: "anthropic", body: String(result) });
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
