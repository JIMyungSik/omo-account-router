import { readFileSync } from "node:fs";
import { authJsonKeysForProvider } from "./auth-slot.ts";
import { resolveProvider } from "./provider-alias.ts";
import type { OarClient } from "./client.ts";
import { decodeJwtPayload } from "./credential-identity.ts";
import type { OAuthCredential, StoredCredential } from "./types.ts";

export { decodeJwtPayload } from "./credential-identity.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!isRecord(value)) return false;
  if (value.type === "oauth") {
    if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") {
      return false;
    }
    if (value.accountId !== undefined && typeof value.accountId !== "string") return false;
    if (value.idToken !== undefined && typeof value.idToken !== "string") return false;
    return true;
  }
  if (value.type === "api_key") {
    return typeof value.key === "string";
  }
  return false;
}

function parseAuthJsonFile(authPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch {
    throw new Error(`unable to read ${authPath}`);
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data)) throw new Error("invalid auth.json");
    return data;
  } catch {
    throw new Error(`invalid auth.json: ${authPath}`);
  }
}

export function expiresFromAccessJwt(access: string): number | undefined {
  const payload = decodeJwtPayload(access);
  const exp = payload?.exp;
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
    return exp * 1000;
  }
  return undefined;
}

export function accountIdFromIdToken(idToken: string): string | undefined {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return undefined;
  const auth = payload["https://api.openai.com/auth"];
  if (isRecord(auth)) {
    const id = auth.chatgpt_account_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  if (typeof payload.chatgpt_account_id === "string" && payload.chatgpt_account_id.length > 0) {
    return payload.chatgpt_account_id;
  }
  return undefined;
}

export function credentialFromNativeCodexAuth(data: unknown): OAuthCredential | undefined {
  if (!isRecord(data)) return undefined;
  const tokens = data.tokens;
  if (!isRecord(tokens)) return undefined;
  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  if (typeof access !== "string" || access.length === 0) return undefined;
  if (typeof refresh !== "string" || refresh.length === 0) return undefined;
  const idToken = typeof tokens.id_token === "string" && tokens.id_token.length > 0 ? tokens.id_token : undefined;
  let accountId = typeof tokens.account_id === "string" && tokens.account_id.length > 0 ? tokens.account_id : undefined;
  if (!accountId && idToken) accountId = accountIdFromIdToken(idToken);
  const expires = expiresFromAccessJwt(access) ?? 0;
  return {
    type: "oauth",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

/**
 * Reads one provider from Senpi auth.json, or a native Codex CLI auth.json when
 * `provider` is `openai-codex` and the file is the Codex tokens document.
 * When the provider slot carries a multi-login `accounts[]` array (e.g. xAI
 * Google + Sign-in-with-Apple under one entry), `opts.account` selects one by
 * 1-based index ("2") or by its `name` field ("login-2"). Without `opts.account`
 * the primary (top-level) credential is returned, as before.
 * Never mints an ID token.
 */
export function readCredentialFromAuthJson(
  authPath: string,
  provider: string,
  opts?: { account?: string },
): StoredCredential {
  const data = parseAuthJsonFile(authPath);
  for (const key of authJsonKeysForProvider(provider)) {
    const slot = data[key];
    if (!isStoredCredential(slot)) continue;
    if (opts?.account) return selectLinkedAccount(slot, provider, authPath, opts.account);
    return slot;
  }
  if (provider === "openai-codex" || provider === "chatgpt-subscription") {
    const native = credentialFromNativeCodexAuth(data);
    if (native) return native;
  }
  const available = Object.keys(data).filter((key) => isStoredCredential(data[key]));
  const looked = authJsonKeysForProvider(provider).join(", ");
  throw new Error(
    `provider ${provider} not found in ${authPath} (looked for ${looked}; available: ${available.join(", ") || "none"})`,
  );
}

/**
 * Picks one credential out of a multi-login `accounts[]` array. Selection is by
 * 1-based index or by the entry's `name` field. The primary token is index 1.
 */
function selectLinkedAccount(
  slot: StoredCredential,
  provider: string,
  authPath: string,
  account: string,
): StoredCredential {
  const linked = (slot as { accounts?: unknown }).accounts;
  if (!Array.isArray(linked) || linked.length === 0) {
    throw new Error(`${provider} in ${authPath} has no accounts[] array; --account cannot be applied`);
  }
  const idx = /^\d+$/.test(account) ? Number(account) - 1 : linked.findIndex((a) => {
    return isRecord(a) && a["name"] === account;
  });
  if (idx < 0 || idx >= linked.length) {
    const names = linked.map((a, i) => (isRecord(a) && typeof a["name"] === "string" ? `${i + 1}=${a["name"]}` : `${i + 1}`)).join(", ");
    throw new Error(`--account ${account} not found in ${provider} accounts[] (available: ${names})`);
  }
  const entry = linked[idx];
  if (!isStoredCredential(entry)) {
    throw new Error(`${provider} accounts[${idx + 1}] in ${authPath} is not a valid credential`);
  }
  return entry;
}

/**
 * Reads every provider slot out of a Senpi/OMO auth.json. Malformed entries
 * are skipped (never thrown) so one bad slot can't block importing the rest.
 * A native Codex auth.json is imported as `openai-codex` only.
 * Never logs credential contents.
 */
export function readAllCredentialsFromAuthJson(authPath: string): Record<string, StoredCredential> {
  const data = parseAuthJsonFile(authPath);
  const out: Record<string, StoredCredential> = {};
  for (const [provider, value] of Object.entries(data)) {
    if (isStoredCredential(value)) {
      out[provider] = value;
    }
  }
  if (!out["chatgpt-subscription"] && out["openai-codex"]) {
    out["chatgpt-subscription"] = out["openai-codex"];
  }
  delete out["openai-codex"];
  if (!out["chatgpt-subscription"]) {
    const native = credentialFromNativeCodexAuth(data);
    if (native) out["chatgpt-subscription"] = native;
  }
  const canonical: Record<string, StoredCredential> = {};
  for (const [provider, credential] of Object.entries(out)) {
    canonical[resolveProvider(provider)] = credential;
  }
  return canonical;
}

export type ImportAllOptions = {
  from: string;
  profile: string;
  /** When false (default), providers that already have a vault credential for `profile` are skipped. */
  force: boolean;
};

export type ImportAllResult = {
  imported: string[];
  skipped: string[];
  errors: Array<{ provider: string; error: string }>;
};

/**
 * Imports every provider slot found in `opts.from` into the OAR vault under
 * `opts.profile`, via the daemon's existing `import-credential` action. By
 * default this never overwrites a provider/profile that already has a vault
 * credential — pass `force: true` to overwrite.
 */
export async function importAllFromAuthJson(client: OarClient, opts: ImportAllOptions): Promise<ImportAllResult> {
  const credentials = readAllCredentialsFromAuthJson(opts.from);
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ provider: string; error: string }> = [];

  for (const [provider, credential] of Object.entries(credentials)) {
    if (!opts.force) {
      const existing = await client.request({
        protocol: 1,
        action: "test",
        provider,
        profile: opts.profile,
      });
      if (existing.ok) {
        const data = existing.data as { availability?: string };
        if (data.availability && data.availability !== "REQUIRES_LOGIN") {
          skipped.push(provider);
          continue;
        }
      }
    }
    const res = await client.request({
      protocol: 1,
      action: "import-credential",
      provider,
      profile: opts.profile,
      credential,
    });
    if (res.ok) imported.push(provider);
    else errors.push({ provider, error: res.error });
  }

  return { imported, skipped, errors };
}
