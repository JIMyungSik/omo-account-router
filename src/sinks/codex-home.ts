import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthCredential, StoredCredential } from "../types.ts";
import type { AccountSink, SinkApplyResult, SinkEnv } from "./types.ts";
import { atomicWriteJson, isRecord, parseJsonText } from "./write-json.ts";

export const CODEX_HOME_SINK_ID = "codex-home" as const;

export function resolveCodexAuthPath(env: SinkEnv): string | undefined {
  const override = env.env.OAR_CODEX_AUTH_PATH;
  if (typeof override === "string" && override.length > 0) {
    return existsSync(override) ? override : undefined;
  }
  const homeDir = env.env.OAR_CODEX_HOME ?? env.env.CODEX_HOME ?? join(env.home, ".codex");
  const authPath = join(homeDir, "auth.json");
  return existsSync(authPath) ? authPath : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isSameCodexIdentity(prevTokens: Record<string, unknown>, credential: OAuthCredential): boolean {
  const prevAccount = nonEmptyString(prevTokens.account_id);
  const nextAccount = nonEmptyString(credential.accountId);
  if (prevAccount && nextAccount && prevAccount !== nextAccount) return false;
  if (prevTokens.access_token === credential.access && prevTokens.refresh_token === credential.refresh) {
    return true;
  }
  if (prevAccount && nextAccount && prevAccount === nextAccount) return true;
  if (credential.idToken && prevTokens.id_token === credential.idToken) return true;
  return false;
}

export function resolveCodexIdToken(
  prevTokens: Record<string, unknown>,
  credential: OAuthCredential,
  sameIdentity: boolean,
): string | undefined {
  const imported = nonEmptyString(credential.idToken);
  if (imported) return imported;
  if (sameIdentity) return nonEmptyString(prevTokens.id_token);
  return undefined;
}

function resolveCodexAccountId(
  prevTokens: Record<string, unknown>,
  credential: OAuthCredential,
  sameIdentity: boolean,
): string | undefined {
  const next = nonEmptyString(credential.accountId);
  if (next) return next;
  if (sameIdentity) return nonEmptyString(prevTokens.account_id);
  return undefined;
}

function tokenFingerprint(tokens: Record<string, unknown>, authMode: unknown, apiKey: unknown): string {
  return JSON.stringify({
    auth_mode: authMode ?? null,
    OPENAI_API_KEY: apiKey ?? null,
    id_token: tokens.id_token ?? null,
    access_token: tokens.access_token ?? null,
    refresh_token: tokens.refresh_token ?? null,
    account_id: tokens.account_id ?? null,
  });
}

export function mapCodexAuthFile(existing: unknown, credential: OAuthCredential): Record<string, unknown> {
  const prev = isRecord(existing) ? existing : {};
  const prevTokens = isRecord(prev.tokens) ? prev.tokens : {};
  const sameIdentity = isSameCodexIdentity(prevTokens, credential);
  const idToken = resolveCodexIdToken(prevTokens, credential, sameIdentity);
  const accountId = resolveCodexAccountId(prevTokens, credential, sameIdentity);

  const tokens: Record<string, unknown> = {};
  if (sameIdentity) {
    for (const [key, value] of Object.entries(prevTokens)) {
      if (key === "access_token" || key === "refresh_token" || key === "id_token" || key === "account_id") {
        continue;
      }
      tokens[key] = value;
    }
  }
  tokens.access_token = credential.access;
  tokens.refresh_token = credential.refresh;
  if (idToken) tokens.id_token = idToken;
  if (accountId) tokens.account_id = accountId;

  const unchanged =
    tokenFingerprint(prevTokens, prev.auth_mode, prev.OPENAI_API_KEY ?? null) ===
    tokenFingerprint(tokens, "chatgpt", null);

  return {
    ...prev,
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens,
    last_refresh: unchanged && typeof prev.last_refresh === "string" ? prev.last_refresh : new Date().toISOString(),
  };
}

export function applyCodexAuthFile(path: string, credential: OAuthCredential): SinkApplyResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail: "read_failed" };
  }
  const parsed = parseJsonText(raw);
  if (!parsed.ok) {
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail: "invalid_json" };
  }
  const prev = isRecord(parsed.value) ? parsed.value : {};
  const prevTokens = isRecord(prev.tokens) ? prev.tokens : {};
  const sameIdentity = isSameCodexIdentity(prevTokens, credential);
  if (!resolveCodexIdToken(prevTokens, credential, sameIdentity)) {
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail: "missing_id_token" };
  }
  const next = mapCodexAuthFile(parsed.value, credential);
  const nextTokens = isRecord(next.tokens) ? next.tokens : {};
  const unchanged =
    tokenFingerprint(prevTokens, prev.auth_mode, prev.OPENAI_API_KEY ?? null) ===
    tokenFingerprint(nextTokens, next.auth_mode, next.OPENAI_API_KEY ?? null);
  if (unchanged) {
    return { id: CODEX_HOME_SINK_ID, status: "skipped", path, detail: "unchanged" };
  }
  try {
    atomicWriteJson(path, next);
  } catch {
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail: "write_failed" };
  }
  return { id: CODEX_HOME_SINK_ID, status: "wrote", path };
}

export function createCodexHomeSink(env: SinkEnv): AccountSink {
  return {
    id: CODEX_HOME_SINK_ID,
    providers: ["openai-codex"],
    apply(credential: StoredCredential): SinkApplyResult {
      if (credential.type !== "oauth") {
        return { id: CODEX_HOME_SINK_ID, status: "skipped", detail: "not_oauth" };
      }
      const path = resolveCodexAuthPath(env);
      if (!path) {
        return { id: CODEX_HOME_SINK_ID, status: "skipped", detail: "no_codex_auth" };
      }
      return applyCodexAuthFile(path, credential);
    },
  };
}
