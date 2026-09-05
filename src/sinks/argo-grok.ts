import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthCredential, StoredCredential } from "../types.ts";
import type { AccountSink, SinkApplyResult, SinkEnv } from "./types.ts";
import { atomicWriteJson, isRecord, parseJsonText } from "./write-json.ts";

export const ARGO_GROK_SINK_ID = "argo-grok" as const;

export function mapXaiToArgoGrok(credential: OAuthCredential): { readonly type: "oauth"; readonly value: string } {
  return {
    type: "oauth",
    value: JSON.stringify({
      access_token: credential.access,
      refresh_token: credential.refresh,
      expires_at: credential.expires,
    }),
  };
}

export function discoverArgoSecretFiles(env: SinkEnv): string[] {
  const override = env.env.OAR_ARGO_SECRETS_PATH;
  if (typeof override === "string" && override.length > 0) {
    return existsSync(override) ? [override] : [];
  }
  const root = join(env.home, "Library", "Application Support", "com.beyondworks.argo", "workspaces");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const accountLocal = join(root, ".account-secrets-local.json");
  if (existsSync(accountLocal)) out.push(accountLocal);
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch (error) {
    if (error instanceof Error) return out;
    throw error;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const secrets = join(root, name, ".secrets.json");
    if (existsSync(secrets)) out.push(secrets);
  }
  return out;
}

function patchArgoSecrets(raw: unknown, grok: { readonly type: "oauth"; readonly value: string }): unknown | null {
  if (!isRecord(raw)) return null;
  const runners = raw.runners;
  if (!isRecord(runners)) return null;
  if (!("grok" in runners)) return null;
  return {
    ...raw,
    runners: {
      ...runners,
      grok,
    },
  };
}

export function applyArgoGrokSecretFile(path: string, credential: OAuthCredential): SinkApplyResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { id: ARGO_GROK_SINK_ID, status: "error", path, detail: "read_failed" };
  }
  const parsed = parseJsonText(raw);
  if (!parsed.ok) {
    return { id: ARGO_GROK_SINK_ID, status: "error", path, detail: "invalid_json" };
  }
  const next = patchArgoSecrets(parsed.value, mapXaiToArgoGrok(credential));
  if (!next) {
    return { id: ARGO_GROK_SINK_ID, status: "skipped", path, detail: "no_runners.grok" };
  }
  try {
    atomicWriteJson(path, next);
  } catch {
    return { id: ARGO_GROK_SINK_ID, status: "error", path, detail: "write_failed" };
  }
  return { id: ARGO_GROK_SINK_ID, status: "wrote", path };
}

export function createArgoGrokSink(env: SinkEnv): AccountSink {
  return {
    id: ARGO_GROK_SINK_ID,
    providers: ["xai"],
    apply(credential: StoredCredential): SinkApplyResult {
      if (credential.type !== "oauth") {
        return { id: ARGO_GROK_SINK_ID, status: "skipped", detail: "not_oauth" };
      }
      const files = discoverArgoSecretFiles(env);
      if (files.length === 0) {
        return { id: ARGO_GROK_SINK_ID, status: "skipped", detail: "no_argo_secrets" };
      }
      const wrote: string[] = [];
      const errors: string[] = [];
      for (const path of files) {
        const result = applyArgoGrokSecretFile(path, credential);
        if (result.status === "wrote" && result.path) wrote.push(result.path);
        if (result.status === "error") errors.push(`${path}: ${result.detail ?? "error"}`);
      }
      if (errors.length > 0 && wrote.length === 0) {
        return { id: ARGO_GROK_SINK_ID, status: "error", detail: errors.join("; ") };
      }
      if (wrote.length === 0) {
        return { id: ARGO_GROK_SINK_ID, status: "skipped", detail: "no_runners.grok" };
      }
      return {
        id: ARGO_GROK_SINK_ID,
        status: "wrote",
        path: wrote.join(","),
        detail: errors.length ? errors.join("; ") : undefined,
      };
    },
  };
}
