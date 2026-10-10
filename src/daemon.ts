import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { isNamedPipePath, oarPidPath } from "./paths.ts";
import { createAdapter } from "./adapters/index.ts";
import { AuthSlotActivator } from "./auth-slot.ts";
import { createDefaultSinks } from "./sinks/index.ts";
import type { AccountSink } from "./sinks/types.ts";
import { classifyFailure } from "./classifier.ts";
import { EventLog } from "./events.ts";
import { LeaseManager } from "./lease.ts";
import type { OarRequest, OarResponse } from "./protocol.ts";
import {
  isInPromotionWindow,
  nextWindowBoundary,
  normalizePromotionSchedule,
  promotionStatusView,
} from "./promotion.ts";
import { PromotionStore } from "./promotion-store.ts";
import { ModelPinStore, modelPinStatusView } from "./model-pin.ts";
import { QueueManager, type QueueEvent, type QueueSleep } from "./queue-manager.ts";
import { createOmoQueueRunner, type OmoCommand, type QueueRunner } from "./queue-runner.ts";
import { annotateQueueTask, annotateQueueTasks, QueueStore } from "./queue-store.ts";
import { AccountRefreshLock } from "./refresh-lock.ts";
import { resolveProvider } from "./provider-alias.ts";
import { parseReportResult } from "./report-results.ts";
import { isEligible, OarRouter } from "./router.ts";
import type { OarStore } from "./store.ts";
import type { StoredCredential } from "./types.ts";
import { fetchRemoteUsageForAccounts } from "./usage/fetch.ts";
import { loginFromXaiUserinfo } from "./xai-login.ts";
import { findXaiReloginHealCandidate } from "./xai-relogin-heal.ts";

export type DaemonOptions = {
  store: OarStore;
  socketPath: string;
  authPaths?: string[];
  activateOnUse?: boolean;
  preferSenpiLock?: boolean;
  sinks?: readonly AccountSink[];
  /** Zero disables background polling. Production daemon-main supplies 60 seconds. */
  quotaPollIntervalMs?: number;
  /** Injected clock for promotional window tests. Wall timers are disabled when set. */
  now?: () => number;
  queueRunner?: QueueRunner;
  omoCommand?: OmoCommand;
  queueRetryDelayMs?: number;
  queueSleep?: QueueSleep;
};

type QuotaPollResult = {
  checked: Array<{ provider: string; profile: string; remainingPercent?: number; ok: boolean }>;
  failovers: Array<{ provider: string; from: string; to: string }>;
};

function readFrame(buf: Buffer<ArrayBufferLike>): {
  msg?: string;
  rest: Buffer<ArrayBufferLike>;
} {
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
  private readonly quotaPollIntervalMs: number;
  private server: Server | null = null;
  private quotaPollTimer: ReturnType<typeof setInterval> | null = null;
  private quotaPollInFlight = false;
  private running = false;
  private lifecycleEpoch = 0;
  private readonly now: () => number;
  private readonly useWallPromotionTimer: boolean;
  private readonly promotionStore: PromotionStore;
  private readonly modelPinStore: ModelPinStore;
  private readonly queueStore: QueueStore;
  private readonly queueManager: QueueManager;
  private readonly queueListeners = new Set<(event: QueueEvent) => void>();
  private promotionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInWindow: boolean | undefined;

  constructor(opts: DaemonOptions) {
    this.store = opts.store;
    this.router = new OarRouter(opts.store);
    this.activator = new AuthSlotActivator({
      store: opts.store,
      authPaths: opts.authPaths,
      preferSenpiLock: opts.preferSenpiLock,
      sinks: opts.sinks ?? createDefaultSinks(),
    });
    this.socketPath = opts.socketPath;
    this.activateOnUse = opts.activateOnUse ?? true;
    this.events = EventLog.forRoot(opts.store.rootDir);
    this.quotaPollIntervalMs = opts.quotaPollIntervalMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.useWallPromotionTimer = opts.now == null;
    this.promotionStore = new PromotionStore({ rootDir: opts.store.rootDir });
    this.modelPinStore = new ModelPinStore({ rootDir: opts.store.rootDir });
    this.queueStore = new QueueStore({ rootDir: opts.store.rootDir });
    this.queueManager = new QueueManager({
      store: this.queueStore,
      schedule: () => this.promotionStore.get(),
      now: this.now,
      runner: opts.queueRunner ?? createOmoQueueRunner(opts.omoCommand ?? { bin: "omo" }),
      emit: (event) => this.emitQueueEvent(event),
      retryDelayMs: opts.queueRetryDelayMs,
      sleep: opts.queueSleep,
    });
  }

  onQueueEvent(handler: (event: QueueEvent) => void): () => void {
    this.queueListeners.add(handler);
    return () => {
      this.queueListeners.delete(handler);
    };
  }

  async reconcilePromotion(): Promise<void> {
    const schedule = this.promotionStore.get();
    const inWindow = isInPromotionWindow(this.now(), schedule);
    if (this.lastInWindow === true && !inWindow) {
      this.emitQueueEvent({ type: "promotion:exited" });
    } else if (this.lastInWindow === false && inWindow) {
      this.emitQueueEvent({ type: "promotion:entered" });
    } else if (this.lastInWindow === undefined && inWindow) {
      this.emitQueueEvent({ type: "promotion:entered" });
    }
    this.lastInWindow = inWindow;
    await this.queueManager.reconcile();
    this.armPromotionTimer();
  }

  private emitQueueEvent(event: QueueEvent): void {
    this.events.append({
      ts: new Date(this.now()).toISOString(),
      event: event.type,
      reason: "id" in event ? event.id : undefined,
    });
    for (const handler of [...this.queueListeners]) handler(event);
  }

  private armPromotionTimer(): void {
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
    if (!this.useWallPromotionTimer || !this.running) return;
    const next = nextWindowBoundary(this.now(), this.promotionStore.get());
    if (!next) return;
    const delay = Math.max(0, Math.min(next.at - this.now(), 2_147_000_000));
    this.promotionTimer = setTimeout(() => {
      void this.reconcilePromotion();
    }, delay);
    this.promotionTimer.unref();
  }

  get refresh(): AccountRefreshLock {
    return this.refreshLock;
  }

  get leaseManager(): LeaseManager {
    return this.leases;
  }

  async start(): Promise<void> {
    const namedPipe = isNamedPipePath(this.socketPath);
    mkdirSync(namedPipe ? this.store.rootDir : dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (!namedPipe && existsSync(this.socketPath)) {
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
          if (!namedPipe) chmodSync(this.socketPath, 0o600);
        } catch {
          // ignore
        }
        resolve();
      });
    });

    writeFileSync(oarPidPath(this.socketPath, this.store.rootDir), String(process.pid), { mode: 0o600 });
    this.running = true;
    this.lifecycleEpoch += 1;
    this.events.append({ ts: new Date().toISOString(), event: "daemon_start", pid: process.pid });
    this.queueManager.resetLifecycle();
    this.queueManager.markStaleRunning();
    await this.reconcilePromotion();
    if (this.quotaPollIntervalMs > 0) {
      void this.runScheduledQuotaPoll();
      this.quotaPollTimer = setInterval(() => {
        void this.runScheduledQuotaPoll();
      }, this.quotaPollIntervalMs);
      this.quotaPollTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.lifecycleEpoch += 1;
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
    await this.queueManager.shutdown();
    if (this.quotaPollTimer) {
      clearInterval(this.quotaPollTimer);
      this.quotaPollTimer = null;
    }
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    if (!isNamedPipePath(this.socketPath) && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
    const pidPath = oarPidPath(this.socketPath, this.store.rootDir);
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
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", async (chunk: Buffer | string) => {
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
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

  /** OIDC userinfo for xAI profiles that JWT decode cannot label. Persists once. */
  private async backfillXaiLogins(provider?: string): Promise<void> {
    if (provider && provider !== "xai") return;
    const pending = this.store.listAccounts("xai").filter((account) => !account.login);
    if (pending.length === 0) return;
    await Promise.all(
      pending.map(async (account) => {
        const login = await loginFromXaiUserinfo(
          this.store.getVaultCredential("xai", account.profile),
        );
        if (!login) return;
        const latest = this.store.getAccount("xai", account.profile);
        if (!latest || latest.login) return;
        this.store.upsertAccount({ ...latest, login });
      }),
    );
  }

  private async healXaiRelogin(): Promise<boolean> {
    const candidate = findXaiReloginHealCandidate(
      this.store,
      this.activator.getAuthPaths(),
    );
    if (!candidate) return false;

    this.store.putVaultCredential("xai", candidate.profile, candidate.credential);
    await this.activator.activate("xai", candidate.profile);
    this.router.use("xai", candidate.profile);
    this.events.append({
      ts: new Date().toISOString(),
      event: "xai_relogin_heal",
      provider: "xai",
      profile: candidate.profile,
      reason: "same_subject_newer_login",
    });
    return true;
  }

  private async fetchVerifiedPositiveProfiles(
    provider: string,
    currentProfile: string,
    guard: () => boolean = () => true,
  ): Promise<Set<string>> {
    const targets = this.store
      .listAccounts(provider)
      .filter((account) => account.profile !== currentProfile)
      .map((account) => ({ provider: account.provider, profile: account.profile }));
    if (!guard()) return new Set<string>();
    // Remove stale eligibility before the network check. Only a successful
    // positive response below may promote a sibling back to AVAILABLE.
    for (const target of targets) {
      const account = this.store.getAccount(target.provider, target.profile);
      if (!account) continue;
      this.store.upsertAccount({
        ...account,
        availability: "QUOTA_UNKNOWN",
        reason: "remote_usage_unverified",
        lastChecked: new Date().toISOString(),
      });
    }
    const rows = await fetchRemoteUsageForAccounts(this.store, targets, {
      root: this.store.rootDir,
      force: true,
      maxAgeMs: 0,
      applyState: false,
      persistCache: false,
      shouldContinue: guard,
    });
    const positive = new Set<string>();
    if (!guard()) return positive;
    for (const row of rows) {
      if (!row.ok) {
        const account = this.store.getAccount(row.provider, row.profile);
        if (account) {
          this.store.upsertAccount({
            ...account,
            availability: "QUOTA_UNKNOWN",
            reason: "remote_usage_unknown",
            lastChecked: new Date().toISOString(),
          });
        }
        continue;
      }
      const primary =
        row.windows.find((window) => window.remainingPercent != null) ?? row.windows[0];
      if (row.extras?.unreported === true || !primary || primary.remainingPercent == null) {
        const account = this.store.getAccount(row.provider, row.profile);
        if (account) {
          this.store.upsertAccount({
            ...account,
            availability: "QUOTA_UNKNOWN",
            reason: row.extras?.unreported === true
              ? "remote_usage_unreported"
              : "remote_usage_unknown",
            lastChecked: new Date().toISOString(),
          });
        }
        continue;
      }
      if (primary.remainingPercent > 0 && !primary.limitReached) {
        positive.add(row.profile);
        this.router.reportResult({
          provider: row.provider,
          account: row.profile,
          result: "QUOTA_AVAILABLE",
          detail: `remote_usage_${primary.label ?? primary.kind}_${primary.remainingPercent}`,
        });
      } else {
        this.router.reportResult({
          provider: row.provider,
          account: row.profile,
          result: "QUOTA_EXHAUSTED",
          detail: `remote_usage_${primary.label ?? primary.kind}_0`,
        });
      }
    }
    return positive;
  }

  private selectVerifiedFailover(
    provider: string,
    currentProfile: string,
    verifiedPositiveProfiles: ReadonlySet<string>,
  ): string | undefined {
    return this.store
      .listAccounts(provider)
      .filter((account) => {
        return (
          account.profile !== currentProfile &&
          verifiedPositiveProfiles.has(account.profile) &&
          isEligible(account)
        );
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        const aUsed = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
        const bUsed = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
        return aUsed - bUsed || a.profile.localeCompare(b.profile);
      })[0]?.profile;
  }

  private pollLifecycleCurrent(epoch: number): boolean {
    return this.running && this.lifecycleEpoch === epoch;
  }

  private pollPolicyCurrent(provider: string, profile: string): boolean {
    const policy = this.store.getProviderPolicy(provider);
    return (
      policy.preferred === profile &&
      policy.autoFailover &&
      (policy.mode === "auto" || process.env.OAR_FORCE_AUTO === "1")
    );
  }

  private async pollQuota(epoch: number): Promise<QuotaPollResult> {
    const state = this.store.getState();
    const checked: Array<{
      provider: string;
      profile: string;
      remainingPercent?: number;
      ok: boolean;
    }> = [];
    const failovers: Array<{ provider: string; from: string; to: string }> = [];

    for (const [provider, policy] of Object.entries(state.providers)) {
      if (!this.pollLifecycleCurrent(epoch)) return { checked, failovers };
      const autoOn =
        policy.autoFailover &&
        (policy.mode === "auto" || process.env.OAR_FORCE_AUTO === "1");
      if (!autoOn || !policy.preferred) continue;
      const current = this.store.getAccount(provider, policy.preferred);
      if (!current) continue;

      const [usage] = await fetchRemoteUsageForAccounts(
        this.store,
        [{ provider: current.provider, profile: current.profile }],
        {
          root: this.store.rootDir,
          force: true,
          maxAgeMs: 0,
          applyState: false,
          persistCache: false,
        },
      );
      if (!this.pollLifecycleCurrent(epoch)) return { checked, failovers };
      if (!this.pollPolicyCurrent(provider, current.profile)) continue;
      if (!usage?.ok) {
        checked.push({ provider, profile: current.profile, ok: false });
        continue;
      }
      const primary =
        usage.windows.find((window) => window.remainingPercent != null) ?? usage.windows[0];
      if (usage.extras?.unreported === true || !primary || primary.remainingPercent == null) {
        checked.push({ provider, profile: current.profile, ok: false });
        continue;
      }
      const remainingPercent = primary.remainingPercent;
      checked.push({ provider, profile: current.profile, remainingPercent, ok: true });
      if (remainingPercent !== 0) {
        this.router.reportResult({
          provider,
          account: current.profile,
          result: "QUOTA_AVAILABLE",
          detail: `quota_poll_${remainingPercent}`,
        });
        continue;
      }

      this.router.reportResult({
        provider,
        account: current.profile,
        result: "QUOTA_EXHAUSTED",
        detail: "quota_poll_0",
      });
      const guard = () =>
        this.pollLifecycleCurrent(epoch) &&
        this.pollPolicyCurrent(provider, current.profile);
      const positive = await this.fetchVerifiedPositiveProfiles(
        provider,
        current.profile,
        guard,
      );
      if (!this.pollLifecycleCurrent(epoch)) return { checked, failovers };
      if (!this.pollPolicyCurrent(provider, current.profile)) continue;
      const nextProfile = this.selectVerifiedFailover(provider, current.profile, positive);
      if (!nextProfile || !this.activateOnUse) continue;

      this.router.use(provider, nextProfile);
      await this.activator.activate(provider, nextProfile);
      failovers.push({ provider, from: current.profile, to: nextProfile });
      this.events.append({
        ts: new Date().toISOString(),
        event: "failover",
        provider,
        profile: nextProfile,
        reason: `from ${current.profile} (quota_poll_0)`,
      });
    }
    this.events.append({
      ts: new Date().toISOString(),
      event: "quota_poll",
      reason: `checked=${checked.length} failovers=${failovers.length}`,
    });
    return { checked, failovers };
  }

  private async runQuotaPollOnce(): Promise<QuotaPollResult | undefined> {
    if (this.quotaPollInFlight) return undefined;
    this.quotaPollInFlight = true;
    const epoch = this.lifecycleEpoch;
    try {
      return await this.pollQuota(epoch);
    } finally {
      this.quotaPollInFlight = false;
    }
  }

  private async runScheduledQuotaPoll(): Promise<void> {
    try {
      await this.runQuotaPollOnce();
    } catch (error) {
      this.events.append({
        ts: new Date().toISOString(),
        event: "quota_poll_error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async dispatch(req: OarRequest): Promise<OarResponse> {
    if (!req || req.protocol !== 1) {
      return { ok: false, error: "unsupported protocol" };
    }
    if ("provider" in req && typeof req.provider === "string") {
      req = { ...req, provider: resolveProvider(req.provider) };
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
                sinks: act.sinks,
                message:
                  resolved.availability === "QUOTA_UNKNOWN"
                    ? `${req.provider} ${req.profile} is now preferred for manual use. ` +
                      "Remote quota is unreported; auto routing will wait for verified usage."
                    : `${req.provider} ${req.profile} is now preferred. ` +
                      "Running OMO sessions will use it on their next eligible request.",
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
      case "order": {
        const accounts = this.store.listAccounts(req.provider);
        if (accounts.length === 0) {
          return { ok: false, error: `no accounts for ${req.provider}` };
        }
        if (req.profiles) {
          const unique = new Set(req.profiles);
          const known = new Set(accounts.map((account) => account.profile));
          if (
            unique.size !== req.profiles.length ||
            req.profiles.length !== accounts.length ||
            req.profiles.some((profile) => !known.has(profile))
          ) {
            return {
              ok: false,
              error:
                `order must list every ${req.provider} profile exactly once ` +
                `(available: ${[...known].join(", ")})`,
            };
          }
          req.profiles.forEach((profile, index) => {
            const account = this.store.getAccount(req.provider, profile);
            if (!account) return;
            this.store.upsertAccount({ ...account, priority: (index + 1) * 100 });
          });
          this.events.append({
            ts: new Date().toISOString(),
            event: "order",
            provider: req.provider,
            reason: req.profiles.join(","),
          });
        }
        const ordered = this.store
          .listAccounts(req.provider)
          .sort((a, b) => a.priority - b.priority || a.profile.localeCompare(b.profile))
          .map((account) => ({ profile: account.profile, priority: account.priority }));
        return { ok: true, data: { provider: req.provider, profiles: ordered } };
      }
      case "mode":
        this.router.setMode(req.provider, req.mode);
        return { ok: true, data: { provider: req.provider, mode: req.mode } };
      case "report": {
        let parsedResult: ReturnType<typeof parseReportResult>;
        try {
          parsedResult = parseReportResult(String(req.result));
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        const existing = this.store.getAccount(req.provider, req.account);
        if (!existing) {
          return {
            ok: false,
            error: `unknown account ${req.provider}/${req.account}`,
          };
        }
        const updated = this.router.reportResult({
          provider: req.provider,
          account: req.account,
          result: parsedResult,
          retryAfterSec: req.retryAfterSec,
          detail: req.detail,
        });
        if (!updated) {
          return {
            ok: false,
            error: `unknown account ${req.provider}/${req.account}`,
          };
        }
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
          policy.preferred === req.account &&
          typeof req.result === "string" &&
          failoverResults.has(req.result)
        ) {
          let nextProfile: string | undefined;
          if (req.result === "QUOTA_EXHAUSTED") {
            nextProfile = this.selectVerifiedFailover(
              req.provider,
              req.account,
              req.verifiedPositiveProfiles
                ? new Set(req.verifiedPositiveProfiles)
                : await this.fetchVerifiedPositiveProfiles(req.provider, req.account),
            );
          } else {
            const next = this.router.resolve({ provider: req.provider });
            nextProfile = next.status === "available" ? next.profile : undefined;
          }
          if (nextProfile && nextProfile !== req.account) {
            try {
              this.router.use(req.provider, nextProfile);
              await this.activator.activate(req.provider, nextProfile);
              failover = { from: req.account, to: nextProfile };
              this.events.append({
                ts: new Date().toISOString(),
                event: "failover",
                provider: req.provider,
                profile: nextProfile,
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
        this.store.backfillAccountLogins();
        await this.backfillXaiLogins();
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
      case "accounts": {
        this.store.backfillAccountLogins(req.provider);
        await this.backfillXaiLogins(req.provider);
        return { ok: true, data: this.store.listAccounts(req.provider) };
      }
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
        const existing = this.store.getAccount(req.provider, req.profile);
        if (!existing) {
          return {
            ok: false,
            error: `unknown account ${req.provider}/${req.profile}`,
          };
        }
        const credential = this.store.getVaultCredential(req.provider, req.profile);
        let authSlots: Array<{ path: string; result: string }> = [];
        if (credential) {
          try {
            authSlots = this.activator.clearMatchingSlots(req.provider, credential);
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        try {
          this.store.removeAccount(req.provider, req.profile);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        this.leases.releaseAccount(req.provider, req.profile);
        this.events.append({
          ts: new Date().toISOString(),
          event: "remove",
          provider: req.provider,
          profile: req.profile,
        });
        return {
          ok: true,
          data: {
            provider: req.provider,
            profile: req.profile,
            authSlotsCleared: authSlots.filter((slot) => slot.result === "cleared").map((slot) => slot.path),
            authSlotsKept: authSlots.filter((slot) => slot.result === "kept").map((slot) => slot.path),
          },
        };
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
        await this.backfillXaiLogins(req.provider);
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
            if (this.activateOnUse && req.activate !== false) {
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
        await this.healXaiRelogin();
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
      case "poll-quota":
        return {
          ok: true,
          data:
            (await this.runQuotaPollOnce()) ??
            { checked: [], failovers: [], skipped: "in_flight" },
        };
      case "doctor":
        return {
          ok: true,
          data: {
            socketPath: this.socketPath,
            rootDir: this.store.rootDir,
            authPaths: this.activator.getAuthPaths(),
            accountCount: this.store.listAccounts().length,
            leaseCount: this.leases.list().length,
            quotaPollIntervalMs: this.quotaPollIntervalMs,
            pid: process.pid,
            promotion: promotionStatusView(this.promotionStore.get(), this.now()),
          },
        };
      case "schedule-configure": {
        const current = this.promotionStore.get();
        try {
          const next = normalizePromotionSchedule({
            ...current,
            enabled: true,
            ...(req.timezone != null ? { timezone: req.timezone } : {}),
            ...(req.start != null ? { start: req.start } : {}),
            ...(req.end != null ? { end: req.end } : {}),
            ...(req.provider != null ? { provider: req.provider } : {}),
            ...(req.model != null ? { model: req.model } : {}),
            ...(req.maxConcurrency != null ? { maxConcurrency: req.maxConcurrency } : {}),
            ...(req.maxAttempts != null ? { maxAttempts: req.maxAttempts } : {}),
          });
          const saved = this.promotionStore.set(next);
          this.events.append({
            ts: new Date(this.now()).toISOString(),
            event: "schedule-configure",
            reason: `${saved.timezone} ${saved.start}-${saved.end} ${saved.provider}/${saved.model}`,
          });
          await this.reconcilePromotion();
          return { ok: true, data: promotionStatusView(saved, this.now()) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "model-pin-set": {
        if (typeof req.provider !== "string" || !req.provider.trim() || typeof req.model !== "string" || !req.model.trim()) {
          return { ok: false, error: "provider and model are required" };
        }
        const pin = this.modelPinStore.set(
          { provider: req.provider.trim(), model: req.model.trim(), thinking: req.thinking },
          this.now(),
        );
        this.events.append({
          ts: pin.setAt,
          event: "model-pin-set",
          reason: `${pin.provider}/${pin.model}`,
        });
        return { ok: true, data: modelPinStatusView(pin) };
      }
      case "model-pin-status":
        return { ok: true, data: modelPinStatusView(this.modelPinStore.get()) };
      case "model-pin-clear": {
        this.modelPinStore.clear();
        this.events.append({ ts: new Date(this.now()).toISOString(), event: "model-pin-clear" });
        return { ok: true, data: modelPinStatusView(undefined) };
      }
      case "schedule-status":
        return { ok: true, data: promotionStatusView(this.promotionStore.get(), this.now()) };
      case "schedule-off": {
        const saved = this.promotionStore.set({ ...this.promotionStore.get(), enabled: false });
        this.events.append({
          ts: new Date(this.now()).toISOString(),
          event: "schedule-off",
        });
        await this.reconcilePromotion();
        return { ok: true, data: promotionStatusView(saved, this.now()) };
      }
      case "queue-add": {
        try {
          const task = this.queueStore.add({
            prompt: req.prompt,
            repository: req.repository,
            isolation: req.isolation,
            maxAttempts: req.maxAttempts ?? this.promotionStore.get().maxAttempts,
            dependsOn: req.dependsOn,
            nowMs: this.now(),
          });
          this.events.append({
            ts: new Date(this.now()).toISOString(),
            event: "queue-add",
            reason: task.id,
          });
          await this.reconcilePromotion();
          const latest = this.queueStore.get(task.id) ?? task;
          return { ok: true, data: annotateQueueTask(latest, this.queueStore.list()) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "queue-list":
        return { ok: true, data: annotateQueueTasks(this.queueStore.list()) };
      case "queue-cancel": {
        try {
          const task = await this.queueManager.cancel(req.id);
          this.events.append({
            ts: new Date(this.now()).toISOString(),
            event: "queue-cancel",
            reason: req.id,
          });
          return { ok: true, data: task };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "queue-retry": {
        try {
          const task = await this.queueManager.retry(req.id);
          this.events.append({
            ts: new Date(this.now()).toISOString(),
            event: "queue-retry",
            reason: req.id,
          });
          return { ok: true, data: task };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      default:
        return { ok: false, error: `unknown action` };
    }
  }
}
