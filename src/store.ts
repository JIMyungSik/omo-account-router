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
import { loginFromCredential } from "./credential-identity.ts";
import { defaultOarRoot, oarStatePath, oarVaultDir } from "./paths.ts";
import { resolveProvider } from "./provider-alias.ts";

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
    if (this.migrateLegacyProviders()) this.persist();
  }

  private migrateLegacyProviders(): boolean {
    let changed = false;
    const accounts = this.state.accounts.map((account) => {
      const provider = resolveProvider(account.provider);
      if (provider === account.provider) return account;
      changed = true;
      this.renameVaultFile(account.provider, provider, account.profile);
      return { ...account, provider, credentialRef: `vault:${provider}:${account.profile}` };
    });
    const providers: OarState["providers"] = {};
    for (const [key, policy] of Object.entries(this.state.providers)) {
      const provider = resolveProvider(key);
      if (provider !== key) changed = true;
      providers[provider] = { ...(providers[provider] ?? {}), ...policy };
    }
    if (!changed) return false;
    this.state = { ...this.state, accounts, providers };
    return true;
  }

  private renameVaultFile(from: string, to: string, profile: string): void {
    const oldPath = join(this.vaultDir, `${from}__${profile}.json`);
    const nextPath = join(this.vaultDir, `${to}__${profile}.json`);
    if (existsSync(oldPath) && !existsSync(nextPath)) renameSync(oldPath, nextPath);
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
    if (!provider) return this.state.accounts;
    const canonical = resolveProvider(provider);
    return this.state.accounts.filter((a) => resolveProvider(a.provider) === canonical);
  }

  getAccount(provider: ProviderId, profile: ProfileId): AccountRecord | undefined {
    const canonical = resolveProvider(provider);
    return this.state.accounts.find(
      (a) => resolveProvider(a.provider) === canonical && a.profile === profile,
    );
  }

  upsertAccount(account: AccountRecord): void {
    const provider = resolveProvider(account.provider);
    const next = provider === account.provider
      ? account
      : { ...account, provider, credentialRef: `vault:${provider}:${account.profile}` };
    const idx = this.state.accounts.findIndex(
      (a) => resolveProvider(a.provider) === provider && a.profile === next.profile,
    );
    account = next;
    if (idx >= 0) this.state.accounts[idx] = account;
    else this.state.accounts.push(account);
    this.persist();
  }

  removeAccount(provider: ProviderId, profile: ProfileId): void {
    const canonical = resolveProvider(provider);
    const vaultPath = this.vaultPath(canonical, profile);
    const legacyPath = join(this.vaultDir, `${provider}__${profile}.json`);
    if (existsSync(vaultPath)) {
      unlinkSync(vaultPath);
    }
    if (legacyPath !== vaultPath && existsSync(legacyPath)) unlinkSync(legacyPath);
    this.state.accounts = this.state.accounts.filter(
      (a) => !(resolveProvider(a.provider) === canonical && a.profile === profile),
    );
    const policy = this.state.providers[canonical] ?? this.state.providers[provider];
    if (policy?.preferred === profile) {
      const next = { ...policy };
      delete next.preferred;
      delete this.state.providers[provider];
      this.state.providers[canonical] = next;
    }
    this.persist();
  }

  getProviderPolicy(provider: ProviderId): ProviderPolicy {
    const canonical = resolveProvider(provider);
    return { ...DEFAULT_POLICY, ...(this.state.providers[canonical] ?? this.state.providers[provider] ?? {}) };
  }

  setProviderMode(provider: ProviderId, mode: ProviderMode): void {
    const canonical = resolveProvider(provider);
    const cur = this.getProviderPolicy(canonical);
    this.state.providers[canonical] = { ...cur, mode };
    this.persist();
  }

  setAutoFailover(provider: ProviderId, enabled: boolean): void {
    const canonical = resolveProvider(provider);
    const cur = this.getProviderPolicy(canonical);
    this.state.providers[canonical] = { ...cur, autoFailover: enabled };
    this.persist();
  }

  setPreferred(provider: ProviderId, profile: ProfileId): void {
    const canonical = resolveProvider(provider);
    const cur = this.getProviderPolicy(canonical);
    this.state.providers[canonical] = { ...cur, preferred: profile };
    this.persist();
  }

  private vaultPath(provider: ProviderId, profile: ProfileId): string {
    return join(this.vaultDir, `${resolveProvider(provider)}__${profile}.json`);
  }

  putVaultCredential(provider: ProviderId, profile: ProfileId, credential: StoredCredential): void {
    atomicWriteJson(this.vaultPath(provider, profile), credential, 0o600);
    const ref = `vault:${provider}:${profile}`;
    const existing = this.getAccount(provider, profile);
    if (existing) {
      const login = loginFromCredential(credential);
      this.upsertAccount({
        ...existing,
        credentialRef: ref,
        auth: "valid",
        lastChecked: new Date().toISOString(),
        ...(login ? { login } : {}),
      });
    }
  }

  /** Persist login only when missing and vault JWT yields an email. */
  backfillAccountLogins(provider?: ProviderId): AccountRecord[] {
    let changed = false;
    for (const account of this.listAccounts(provider)) {
      if (account.login) continue;
      const login = loginFromCredential(this.getVaultCredential(account.provider, account.profile));
      if (!login) continue;
      const idx = this.state.accounts.findIndex(
        (a) => a.provider === account.provider && a.profile === account.profile,
      );
      if (idx < 0) continue;
      this.state.accounts[idx] = { ...account, login };
      changed = true;
    }
    if (changed) this.persist();
    return this.listAccounts(provider);
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
