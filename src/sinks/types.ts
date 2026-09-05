import type { ProviderId, StoredCredential } from "../types.ts";

export type SinkStatus = "wrote" | "skipped" | "error";

export type SinkApplyResult = {
  readonly id: string;
  readonly status: SinkStatus;
  readonly path?: string;
  readonly detail?: string;
};

export type AccountSink = {
  readonly id: string;
  readonly providers: readonly ProviderId[];
  apply(credential: StoredCredential): SinkApplyResult;
};

export type SinkEnv = {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
};
