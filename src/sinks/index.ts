import { homedir } from "node:os";
import { createArgoGrokSink } from "./argo-grok.ts";
import { createCodexHomeSink } from "./codex-home.ts";
import type { AccountSink, SinkApplyResult, SinkEnv } from "./types.ts";

export type { AccountSink, SinkApplyResult, SinkEnv, SinkStatus } from "./types.ts";
export { createArgoGrokSink, mapXaiToArgoGrok, discoverArgoSecretFiles, applyArgoGrokSecretFile } from "./argo-grok.ts";
export { createCodexHomeSink, mapCodexAuthFile, resolveCodexAuthPath, applyCodexAuthFile } from "./codex-home.ts";

function flagOff(value: string | undefined): boolean {
  return value === "0" || value === "false" || value === "off";
}

export function formatSinkResultLines(sinks: readonly SinkApplyResult[]): string[] {
  return sinks.map((sink) => {
    const parts = [sink.id, sink.status];
    if (typeof sink.path === "string" && sink.path.length > 0) parts.push(sink.path);
    if (typeof sink.detail === "string" && sink.detail.length > 0) parts.push(sink.detail);
    return `sink: ${parts.join(" ")}`;
  });
}

export function createDefaultSinks(opts?: { home?: string; env?: NodeJS.ProcessEnv }): AccountSink[] {
  const env: SinkEnv = {
    home: opts?.home ?? homedir(),
    env: opts?.env ?? process.env,
  };
  if (flagOff(env.env.OAR_SINKS)) return [];
  const sinks: AccountSink[] = [];
  if (!flagOff(env.env.OAR_ARGO_SINK)) {
    sinks.push(createArgoGrokSink(env));
  }
  if (!flagOff(env.env.OAR_CODEX_SINK)) {
    sinks.push(createCodexHomeSink(env));
  }
  return sinks;
}
