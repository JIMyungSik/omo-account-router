import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  AccountRecord,
  OarState,
  ProfileId,
  ProviderId,
  ProviderMode,
  ProviderPolicy,
  StoredCredential,
} from "./types.ts";
import { defaultOarRoot, oarStatePath, oarVaultDir } from "./paths.ts";

const DEFAULT_POLICY: ProviderPolicy = {
  mode: "manual",
  autoFailover: false,
};

function emptyState(): OarState {
  return { version: 1, providers: {}, accounts: [], updatedAt: new Date().toISOString() };
}

function atomicWriteJson(path: string, data: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    // best effort on platforms without chmod
  }
}

export class OarStore {
  readonly rootDir: string;
  private statePath: string;
  private vaultDir: string;
  private state: OarState;

  constructor(opts?: { rootDir?: string }) {
    this.rootDir = opts?.rootDir ?? defaultOarRoot();
    this.statePath = oarStatePath(this.rootDir);
    this.vaultDir = oarVaultDir(this.rootDir);
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    this.state = this.load();
  }

  private load(): OarState {
    if (!existsSync(this.statePath)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as OarState;
      if (parsed?.version !== 1) return emptyState();
      return {
        version: 1,
        providers: parsed.providers ?? {},
        accounts: parsed.accounts ?? [],
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch {
      return emptyState();
    }
  }

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    atomicWriteJson(this.statePath, this.state, 0o600);
  }

  getState(): OarState {
    return structuredClone(this.state);
  }

  listAccounts(provider?: ProviderId): AccountRecord[] {
    return this.state.accounts.filter((a) => (provider ? a.provider === provider : true));
  }

  getAccount(provider: ProviderId, profile: ProfileId): AccountRecord | undefined {
    return this.state.accounts.find((a) => a.provider === provider && a.profile === profile);
  }

  upsertAccount(account: AccountRecord): void {
    const idx = this.state.accounts.findIndex(
      (a) => a.provider === account.provider && a.profile === account.profile,
    );
    if (idx >= 0) this.state.accounts[idx] = account;
    else this.state.accounts.push(account);
    this.persist();
  }

  removeAccount(provider: ProviderId, profile: ProfileId): void {
    this.state.accounts = this.state.accounts.filter(
      (a) => !(a.provider === provider && a.profile === profile),
    );
    this.persist();
    const vaultPath = this.vaultPath(provider, profile);
    if (existsSync(vaultPath)) {
      try {
        unlinkSync(vaultPath);
      } catch {
        // ignore
      }
    }
  }

  getProviderPolicy(provider: ProviderId): ProviderPolicy {
    return { ...DEFAULT_POLICY, ...(this.state.providers[provider] ?? {}) };
  }

  setProviderMode(provider: ProviderId, mode: ProviderMode): void {
    const cur = this.getProviderPolicy(provider);
    this.state.providers[provider] = { ...cur, mode };
    this.persist();
  }

  setAutoFailover(provider: ProviderId, enabled: boolean): void {
    const cur = this.getProviderPolicy(provider);
    this.state.providers[provider] = { ...cur, autoFailover: enabled };
    this.persist();
  }

  setPreferred(provider: ProviderId, profile: ProfileId): void {
    const cur = this.getProviderPolicy(provider);
    this.state.providers[provider] = { ...cur, preferred: profile };
    this.persist();
  }

  private vaultPath(provider: ProviderId, profile: ProfileId): string {
    return join(this.vaultDir, `${provider}__${profile}.json`);
  }

  putVaultCredential(provider: ProviderId, profile: ProfileId, credential: StoredCredential): void {
    atomicWriteJson(this.vaultPath(provider, profile), credential, 0o600);
    const ref = `vault:${provider}:${profile}`;
    const existing = this.getAccount(provider, profile);
    if (existing) {
      this.upsertAccount({ ...existing, credentialRef: ref, auth: "valid", lastChecked: new Date().toISOString() });
    }
  }

  getVaultCredential(provider: ProviderId, profile: ProfileId): StoredCredential | undefined {
    const path = this.vaultPath(provider, profile);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as StoredCredential;
    } catch {
      return undefined;
    }
  }
}
