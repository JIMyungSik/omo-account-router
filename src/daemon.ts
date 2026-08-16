import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createAdapter } from "./adapters/index.ts";
import { AuthSlotActivator } from "./auth-slot.ts";
import { classifyFailure } from "./classifier.ts";
import { EventLog } from "./events.ts";
import { LeaseManager } from "./lease.ts";
import type { OarRequest, OarResponse } from "./protocol.ts";
import { AccountRefreshLock } from "./refresh-lock.ts";
import { OarRouter } from "./router.ts";
import type { OarStore } from "./store.ts";
import type { StoredCredential } from "./types.ts";

export type DaemonOptions = {
  store: OarStore;
  socketPath: string;
  authPaths?: string[];
  activateOnUse?: boolean;
  preferSenpiLock?: boolean;
};

function readFrame(buf: Buffer): { msg?: string; rest: Buffer } {
  const idx = buf.indexOf(0);
  if (idx === -1) return { rest: buf };
  return { msg: buf.subarray(0, idx).toString("utf8"), rest: buf.subarray(idx + 1) };
}

export class OarDaemon {
  private readonly store: OarStore;
  private readonly router: OarRouter;
  private readonly activator: AuthSlotActivator;
  private readonly socketPath: string;
  private readonly activateOnUse: boolean;
  private readonly refreshLock = new AccountRefreshLock();
  private readonly leases = new LeaseManager();
  private readonly events: EventLog;
  private server: Server | null = null;

  constructor(opts: DaemonOptions) {
    this.store = opts.store;
    this.router = new OarRouter(opts.store);
    this.activator = new AuthSlotActivator({
      store: opts.store,
      authPaths: opts.authPaths,
      preferSenpiLock: opts.preferSenpiLock,
    });
    this.socketPath = opts.socketPath;
    this.activateOnUse = opts.activateOnUse ?? true;
    this.events = EventLog.forRoot(opts.store.rootDir);
  }

  get refresh(): AccountRefreshLock {
    return this.refreshLock;
  }

  get leaseManager(): LeaseManager {
    return this.leases;
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }

    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        try {
          chmodSync(this.socketPath, 0o600);
        } catch {
          // ignore
        }
        resolve();
      });
    });

    writeFileSync(`${this.socketPath}.pid`, String(process.pid), { mode: 0o600 });
    this.events.append({ ts: new Date().toISOString(), event: "daemon_start", pid: process.pid });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
    const pidPath = `${this.socketPath}.pid`;
    if (existsSync(pidPath)) {
      try {
        unlinkSync(pidPath);
      } catch {
        // ignore
      }
    }
    this.events.append({ ts: new Date().toISOString(), event: "daemon_stop", pid: process.pid });
  }

  private handleSocket(socket: Socket): void {
    let buf = Buffer.alloc(0);
    socket.on("data", async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const { msg, rest } = readFrame(buf);
        buf = rest;
        if (msg === undefined) break;
        let response: OarResponse;
        try {
          const req = JSON.parse(msg) as OarRequest;
          response = await this.dispatch(req);
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        socket.write(Buffer.concat([Buffer.from(JSON.stringify(response), "utf8"), Buffer.from([0])]));
      }
    });
  }

  async dispatch(req: OarRequest): Promise<OarResponse> {
    if (!req || req.protocol !== 1) {
      return { ok: false, error: "unsupported protocol" };
    }

    switch (req.action) {
      case "ping":
        return { ok: true, data: { pong: true, pid: process.pid } };
      case "resolve": {
        const resolved = this.router.resolve(req);
        // Keep live auth.json aligned with the resolved profile so external
        // overwrites (or a prior exhausted main slot) cannot silently stick.
        if (this.activateOnUse && resolved.status === "available" && resolved.profile) {
          try {
            await this.activator.ensureActivated(req.provider, resolved.profile);
          } catch {
            // non-fatal: resolve still returns the profile choice
          }
        }
        return { ok: true, data: resolved };
      }
      case "use": {
        try {
          const resolved = this.router.use(req.provider, req.profile, { force: Boolean(req.force) });
          this.events.append({
            ts: new Date().toISOString(),
            event: "use",
            provider: req.provider,
            profile: req.profile,
            reason: req.force ? "manual-force" : "manual",
            pid: process.pid,
          });
          if (this.activateOnUse) {
            const act = await this.activator.activate(req.provider, req.profile);
            return {
              ok: true,
              data: {
                ...resolved,
                activatedPaths: act.paths,
                via: act.via,
                message: `${req.provider} ${req.profile} is now preferred. Running OMO sessions will use it on their next eligible request.`,
              },
            };
          }
          return { ok: true, data: resolved };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { ok: false, error: msg };
        }
      }
      case "auto":
        this.store.setProviderMode(req.provider, req.enabled ? "auto" : "manual");
        this.store.setAutoFailover(req.provider, req.enabled);
        this.events.append({
          ts: new Date().toISOString(),
          event: "auto",
          provider: req.provider,
          reason: req.enabled ? "on" : "off",
        });
        return {
          ok: true,
          data: { provider: req.provider, mode: req.enabled ? "auto" : "manual", autoFailover: req.enabled },
        };
      case "mode":
        this.router.setMode(req.provider, req.mode);
        return { ok: true, data: { provider: req.provider, mode: req.mode } };
      case "report": {
        const updated = this.router.reportResult({
          provider: req.provider,
          account: req.account,
          result: req.result,
          retryAfterSec: req.retryAfterSec,
          detail: req.detail,
        });
        this.events.append({
          ts: new Date().toISOString(),
          event: "report",
          provider: req.provider,
          profile: req.account,
          reason: String(req.result),
        });
        const policy = this.store.getProviderPolicy(req.provider);
        const failoverResults = new Set([
          "AUTH_REVOKED",
          "AUTH_EXPIRED",
          "RATE_LIMITED",
          "QUOTA_EXHAUSTED",
        ]);
        const autoOn =
          policy.autoFailover &&
          (policy.mode === "auto" || process.env.OAR_FORCE_AUTO === "1");
        let failover: { from: string; to: string } | undefined;
        if (
          this.activateOnUse &&
          autoOn &&
          typeof req.result === "string" &&
          failoverResults.has(req.result)
        ) {
          const next = this.router.resolve({ provider: req.provider });
          if (next.status === "available" && next.profile && next.profile !== req.account) {
            try {
              this.router.use(req.provider, next.profile);
              await this.activator.activate(req.provider, next.profile);
              failover = { from: req.account, to: next.profile };
              this.events.append({
                ts: new Date().toISOString(),
                event: "failover",
                provider: req.provider,
                profile: next.profile,
                reason: `from ${req.account} (${String(req.result)})`,
              });
            } catch {
              // vault may be missing for the next profile
            }
          }
        }
        return { ok: true, data: { account: updated, failover } };
      }
      case "status": {
        const state = this.store.getState();
        const providers = [...new Set(state.accounts.map((a) => a.provider))];
        return {
          ok: true,
          data: {
            state,
            authPaths: this.activator.getAuthPaths(),
            accounts: state.accounts,
            leases: this.leases.list(),
            resolvePreview: providers.map((p) => this.router.resolve({ provider: p })),
          },
        };
      }
      case "accounts":
        return { ok: true, data: this.store.listAccounts(req.provider) };
      case "add": {
        this.store.upsertAccount({
          provider: req.provider,
          profile: req.profile,
          auth: "unknown",
          availability: "UNKNOWN",
          priority: req.priority ?? 100,
          credentialRef: `vault:${req.provider}:${req.profile}`,
        });
        return { ok: true, data: this.store.getAccount(req.provider, req.profile) };
      }
      case "remove": {
        this.store.removeAccount(req.provider, req.profile);
        this.events.append({
          ts: new Date().toISOString(),
          event: "remove",
          provider: req.provider,
          profile: req.profile,
        });
        return { ok: true, data: { provider: req.provider, profile: req.profile } };
      }
      case "import-credential": {
        const credential = req.credential as StoredCredential;
        if (!credential || (credential.type !== "oauth" && credential.type !== "api_key")) {
          return { ok: false, error: "credential must be oauth or api_key" };
        }
        if (!this.store.getAccount(req.provider, req.profile)) {
          this.store.upsertAccount({
            provider: req.provider,
            profile: req.profile,
            auth: "valid",
            availability: "AVAILABLE",
            priority: 100,
            credentialRef: `vault:${req.provider}:${req.profile}`,
          });
        }
        this.store.putVaultCredential(req.provider, req.profile, credential);
        return { ok: true, data: { provider: req.provider, profile: req.profile } };
      }
      case "activate": {
        const act = await this.activator.activate(req.provider, req.profile);
        this.router.use(req.provider, req.profile);
        return { ok: true, data: act };
      }
      case "acquire-lease": {
        const resolved = req.profile
          ? { profile: req.profile, status: "available" as const }
          : this.router.resolve({ provider: req.provider });
        if (resolved.status !== "available" || !resolved.profile) {
          return { ok: false, error: `no eligible account for ${req.provider}` };
        }
        const account = this.store.getAccount(req.provider, resolved.profile);
        const result = this.leases.acquire({
          provider: req.provider,
          profile: resolved.profile,
          holder: req.holder,
          maxConcurrent: account?.maxConcurrent,
        });
        if (!result.ok) {
          return { ok: false, error: `account ${req.provider}/${resolved.profile} at maxConcurrent (${result.holders})` };
        }
        return { ok: true, data: result.lease };
      }
      case "release-lease": {
        if (req.leaseId) {
          return { ok: true, data: { released: this.leases.release(req.leaseId) } };
        }
        if (req.holder) {
          return { ok: true, data: { released: this.leases.releaseHolder(req.holder) } };
        }
        return { ok: false, error: "leaseId or holder required" };
      }
      case "refresh": {
        const account = this.store.getAccount(req.provider, req.profile);
        if (!account) return { ok: false, error: `unknown account ${req.provider}/${req.profile}` };
        const adapter = createAdapter(req.provider, this.store);
        if (!adapter?.executeRefresh) return { ok: false, error: `no refresh adapter for ${req.provider}` };
        const cred = this.store.getVaultCredential(req.provider, req.profile);
        if (!cred) return { ok: false, error: "missing vault credential" };
        try {
          const refreshed = await this.refreshLock.withLock(`${req.provider}:${req.profile}`, async () => {
            const latest = this.store.getVaultCredential(req.provider, req.profile) ?? cred;
            if (latest.type === "oauth" && Date.now() + 5 * 60 * 1000 < latest.expires) {
              return { credential: latest, skipped: true as const };
            }
            const result = await adapter.executeRefresh!(account, latest);
            this.store.putVaultCredential(req.provider, req.profile, result.credential);
            if (this.activateOnUse) {
              await this.activator.activate(req.provider, req.profile);
            }
            return { credential: result.credential, skipped: false as const };
          });
          this.events.append({
            ts: new Date().toISOString(),
            event: "refresh",
            provider: req.provider,
            profile: req.profile,
            reason: refreshed.skipped ? "already_fresh" : "rotated",
          });
          return { ok: true, data: { provider: req.provider, profile: req.profile, skipped: refreshed.skipped } };
        } catch (error) {
          const classified = classifyFailure({
            provider: req.provider,
            status: (error as { status?: number }).status,
            body: error instanceof Error ? error.message : String(error),
          });
          this.router.reportResult({
            provider: req.provider,
            account: req.profile,
            result: classified,
            detail: error instanceof Error ? error.message : String(error),
          });
          this.events.append({
            ts: new Date().toISOString(),
            event: "refresh_failed",
            provider: req.provider,
            profile: req.profile,
            reason: classified,
          });
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "test": {
        const account = this.store.getAccount(req.provider, req.profile);
        if (!account) return { ok: false, error: `unknown account ${req.provider}/${req.profile}` };
        const adapter = createAdapter(req.provider, this.store);
        if (!adapter) {
          return {
            ok: true,
            data: { provider: req.provider, profile: req.profile, health: "UNKNOWN", note: "no adapter" },
          };
        }
        const health = await adapter.healthCheck(account);
        if (!req.live) {
          return { ok: true, data: { provider: req.provider, profile: req.profile, ...health } };
        }
        // --live: best-effort network probe only. Never mutates router/account
        // state — an unexpected status must not silently mark a working
        // account as revoked (informational output only).
        let live: unknown;
        if (!adapter.liveCheck) {
          live = { reachable: null, detail: "no live check implemented for this provider" };
        } else {
          const cred = this.store.getVaultCredential(req.provider, req.profile);
          if (!cred) {
            live = { reachable: false, detail: "missing_vault_credential" };
          } else {
            try {
              live = await adapter.liveCheck(account, cred);
            } catch (error) {
              live = { reachable: false, detail: error instanceof Error ? error.message : String(error) };
            }
          }
        }
        return { ok: true, data: { provider: req.provider, profile: req.profile, ...health, live } };
      }
      case "bootstrap-auto": {
        const state = this.store.getState();
        const byProvider = new Map<string, typeof state.accounts>();
        for (const a of state.accounts) {
          const list = byProvider.get(a.provider) ?? [];
          list.push(a);
          byProvider.set(a.provider, list);
        }
        const enabled: Array<{ provider: string; profiles: number; preferred?: string }> = [];
        for (const [provider, accounts] of byProvider) {
          if (accounts.length < 2) continue;
          this.store.setProviderMode(provider, "auto");
          this.store.setAutoFailover(provider, true);
          const preferred =
            this.store.getProviderPolicy(provider).preferred ??
            [...accounts].sort((a, b) => a.priority - b.priority)[0]?.profile;
          if (preferred && this.activateOnUse) {
            try {
              await this.activator.ensureActivated(provider, preferred);
              this.router.use(provider, preferred);
            } catch {
              // vault missing — still enable auto for later import
            }
          }
          enabled.push({ provider, profiles: accounts.length, preferred });
          this.events.append({
            ts: new Date().toISOString(),
            event: "bootstrap-auto",
            provider,
            reason: `profiles=${accounts.length}`,
          });
        }
        return { ok: true, data: { enabled, forceAuto: process.env.OAR_FORCE_AUTO === "1" } };
      }
      case "doctor":
        return {
          ok: true,
          data: {
            socketPath: this.socketPath,
            rootDir: this.store.rootDir,
            authPaths: this.activator.getAuthPaths(),
            accountCount: this.store.listAccounts().length,
            leaseCount: this.leases.list().length,
            pid: process.pid,
          },
        };
      default:
        return { ok: false, error: `unknown action` };
    }
  }
}
