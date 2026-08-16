import { classifyFailure } from "../classifier.ts";
import type { AccountRecord, FailureType, StoredCredential } from "../types.ts";
import type { AccountState, CredentialHandle, LiveCheckResult, ProviderAdapter, RefreshResult } from "./types.ts";
import type { OarStore } from "../store.ts";

/** Public OAuth client id from installed senpi pi-ai openai-codex — not a secret. */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

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

  async executeRefresh(_account: AccountRecord, credential: StoredCredential): Promise<RefreshResult> {
    if (credential.type !== "oauth") {
      throw new Error("openai-codex refresh requires oauth credential");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CODEX_CLIENT_ID,
    });
    const response = await fetch(CODEX_TOKEN_URL, {
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
      throw new Error(`openai-codex OAuth token refresh failed (HTTP ${response.status}): invalid JSON`);
    }
    if (!response.ok) {
      const error = typeof parsed.error === "string" ? parsed.error : undefined;
      const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined;
      const detail = [error, description].filter(Boolean).join(": ");
      const err = new Error(
        `openai-codex OAuth token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
      (err as Error & { status?: number; body?: string }).status = response.status;
      (err as Error & { status?: number; body?: string }).body = detail;
      throw err;
    }
    const access = parsed.access_token;
    if (typeof access !== "string" || access.length === 0) {
      throw new Error("Invalid openai-codex OAuth response field: access_token");
    }
    const refresh = parsed.refresh_token === undefined ? credential.refresh : parsed.refresh_token;
    if (typeof refresh !== "string" || refresh.length === 0) {
      throw new Error("Invalid openai-codex OAuth response field: refresh_token");
    }
    const expiresInSeconds =
      parsed.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : Number(parsed.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error("Invalid openai-codex OAuth response field: expires_in");
    }
    return {
      credential: {
        type: "oauth",
        access,
        refresh,
        expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
        // Preserve accountId — Codex requests are routed by ChatGPT account id,
        // not just bearer token, and the token endpoint does not return it.
        ...(credential.accountId ? { accountId: credential.accountId } : {}),
      },
    };
  }

  /**
   * Best-effort connectivity probe. ChatGPT/Codex OAuth tokens are backend
   * session tokens, not standard OpenAI API keys — `api.openai.com` may
   * reject them for reasons unrelated to token health (wrong API surface).
   * Informational only, does not mutate router state.
   */
  async liveCheck(_account: AccountRecord, credential: StoredCredential): Promise<LiveCheckResult> {
    const token = credential.type === "oauth" ? credential.access : credential.key;
    try {
      const response = await fetch("https://api.openai.com/v1/models", {
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
