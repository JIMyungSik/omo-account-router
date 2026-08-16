import type {
  FailureType,
  ProfileId,
  ProviderId,
  ProviderMode,
  ResolveResponse,
  AccountRecord,
  OarState,
} from "./types.ts";

export type OarRequest =
  | { protocol: 1; action: "ping" }
  | { protocol: 1; action: "resolve"; provider: ProviderId; model?: string; member?: string }
  | { protocol: 1; action: "use"; provider: ProviderId; profile: ProfileId; force?: boolean }
  | { protocol: 1; action: "auto"; provider: ProviderId; enabled: boolean }
  | { protocol: 1; action: "mode"; provider: ProviderId; mode: ProviderMode }
  | {
      protocol: 1;
      action: "report";
      provider: ProviderId;
      account: ProfileId;
      result: FailureType | "SUCCESS";
      retryAfterSec?: number;
      detail?: string;
    }
  | { protocol: 1; action: "status" }
  | { protocol: 1; action: "accounts"; provider?: ProviderId }
  | {
      protocol: 1;
      action: "add";
      provider: ProviderId;
      profile: ProfileId;
      priority?: number;
    }
  | {
      protocol: 1;
      action: "import-credential";
      provider: ProviderId;
      profile: ProfileId;
      credential: unknown;
    }
  | { protocol: 1; action: "activate"; provider: ProviderId; profile: ProfileId }
  | { protocol: 1; action: "remove"; provider: ProviderId; profile: ProfileId }
  | {
      protocol: 1;
      action: "acquire-lease";
      provider: ProviderId;
      profile?: ProfileId;
      holder: string;
    }
  | { protocol: 1; action: "release-lease"; leaseId?: string; holder?: string }
  | { protocol: 1; action: "refresh"; provider: ProviderId; profile: ProfileId }
  | { protocol: 1; action: "test"; provider: ProviderId; profile: ProfileId; live?: boolean }
  | { protocol: 1; action: "doctor" }
  /** Enable auto+failover for every provider that has 2+ vault profiles. */
  | { protocol: 1; action: "bootstrap-auto" };

export type OarResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export type StatusView = {
  state: OarState;
  authPaths: string[];
  resolvePreview: ResolveResponse[];
  accounts: AccountRecord[];
};
