import type { AccountLease, ProfileId, ProviderId } from "./types.ts";

export type AcquireResult =
  | { ok: true; lease: AccountLease }
  | { ok: false; reason: "max_concurrent"; holders: number };

/** Default lease lifetime so crashed agents do not pin capacity forever. */
export const DEFAULT_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

export class LeaseManager {
  private leases = new Map<string, AccountLease>();
  private readonly ttlMs: number;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  private isExpired(lease: AccountLease, now = Date.now()): boolean {
    const acquired = Date.parse(lease.acquiredAt);
    if (!Number.isFinite(acquired)) return true;
    return now - acquired > this.ttlMs;
  }

  /** Drop expired leases. Returns how many were removed. */
  sweep(now = Date.now()): number {
    let n = 0;
    for (const [id, lease] of this.leases) {
      if (this.isExpired(lease, now)) {
        this.leases.delete(id);
        n += 1;
      }
    }
    return n;
  }

  acquire(opts: {
    provider: ProviderId;
    profile: ProfileId;
    holder: string;
    maxConcurrent?: number;
  }): AcquireResult {
    this.sweep();
    const active = [...this.leases.values()].filter(
      (l) => l.provider === opts.provider && l.profile === opts.profile,
    );
    if (opts.maxConcurrent != null && active.length >= opts.maxConcurrent) {
      return { ok: false, reason: "max_concurrent", holders: active.length };
    }
    const lease: AccountLease = {
      id: crypto.randomUUID(),
      provider: opts.provider,
      profile: opts.profile,
      holder: opts.holder,
      acquiredAt: new Date().toISOString(),
    };
    this.leases.set(lease.id, lease);
    return { ok: true, lease };
  }

  release(leaseId: string): boolean {
    this.sweep();
    return this.leases.delete(leaseId);
  }

  releaseHolder(holder: string): number {
    this.sweep();
    let n = 0;
    for (const [id, lease] of this.leases) {
      if (lease.holder === holder) {
        this.leases.delete(id);
        n += 1;
      }
    }
    return n;
  }

  list(): AccountLease[] {
    this.sweep();
    return [...this.leases.values()];
  }

  count(provider: ProviderId, profile: ProfileId): number {
    this.sweep();
    return [...this.leases.values()].filter((l) => l.provider === provider && l.profile === profile)
      .length;
  }
}
