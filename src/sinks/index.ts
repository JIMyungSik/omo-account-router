import { homedir } from "node:os";
import { createArgoGrokSink } from "./argo-grok.ts";
import { createCodexHomeSink } from "./codex-home.ts";
import type { AccountSink, SinkEnv } from "./types.ts";

export type { AccountSink, SinkApplyResult, SinkEnv, SinkStatus } from "./types.ts";
export { createArgoGrokSink, mapXaiToArgoGrok, discoverArgoSecretFiles, applyArgoGrokSecretFile } from "./argo-grok.ts";
export { createCodexHomeSink, mapCodexAuthFile, resolveCodexAuthPath, applyCodexAuthFile } from "./codex-home.ts";

function flagOff(value: string | undefined): boolean {
  return value === "0" || value === "false" || value === "off";
}

export function createDefaultSinks(opts?: { home?: string; env?: NodeJS.ProcessEnv }): AccountSink[] {
  const env: SinkEnv = {
    home: opts?.home ?? homedir(),
    env: opts?.env ?? process.env,
  };
  if (flagOff(env.env.OAR_SINKS)) return [];
  // bun test sets BUN_TEST; never dual-write the developer's Argo/Codex homes.
  if (env.env.BUN_TEST === "1" || env.env.BUN_TEST === "true") return [];
  const sinks: AccountSink[] = [];
  if (!flagOff(env.env.OAR_ARGO_SINK)) sinks.push(createArgoGrokSink(env));
  if (!flagOff(env.env.OAR_CODEX_SINK)) sinks.push(createCodexHomeSink(env));
  return sinks;
}
