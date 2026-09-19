import { emailFromUnknown } from "./credential-identity.ts";
import type { StoredCredential } from "./types.ts";

/** OIDC userinfo — scope already includes `email` on xAI Grok CLI tokens. */
export const XAI_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";

/**
 * Best-effort xAI login email. Never logs the token. Returns undefined on
 * expiry/network/non-email payloads so status stays sync-fast after persist.
 */
export async function loginFromXaiUserinfo(
  cred: StoredCredential | undefined,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<string | undefined> {
  if (!cred || cred.type !== "oauth") return undefined;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  try {
    const response = await fetchImpl(XAI_USERINFO_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cred.access}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return emailFromUnknown((parsed as Record<string, unknown>).email);
  } catch {
    return undefined;
  }
}
