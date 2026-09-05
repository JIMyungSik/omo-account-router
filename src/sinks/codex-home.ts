import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthCredential, StoredCredential } from "../types.ts";
import type { AccountSink, SinkApplyResult, SinkEnv } from "./types.ts";
import { atomicWriteJson, isRecord } from "./write-json.ts";

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

export function mapCodexAuthFile(existing: unknown, credential: OAuthCredential): Record<string, unknown> {
  const prev = isRecord(existing) ? existing : {};
  const prevTokens = isRecord(prev.tokens) ? prev.tokens : {};
  const same =
    prevTokens.access_token === credential.access && prevTokens.refresh_token === credential.refresh;

  const tokens: Record<string, unknown> = {
    access_token: credential.access,
    refresh_token: credential.refresh,
  };
  if (typeof credential.accountId === "string") {
    tokens.account_id = credential.accountId;
  } else if (typeof prevTokens.account_id === "string") {
    tokens.account_id = prevTokens.account_id;
  }
  if (same && typeof prevTokens.id_token === "string") {
    tokens.id_token = prevTokens.id_token;
  }

  const authMode = typeof prev.auth_mode === "string" ? prev.auth_mode : "chatgpt";
  return {
    ...prev,
    auth_mode: authMode,
    tokens,
    last_refresh: new Date().toISOString(),
  };
}

export function applyCodexAuthFile(path: string, credential: OAuthCredential): SinkApplyResult {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail };
  }
  try {
    atomicWriteJson(path, mapCodexAuthFile(parsed, credential));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: CODEX_HOME_SINK_ID, status: "error", path, detail };
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
