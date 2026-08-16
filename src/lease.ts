import { randomUUID } from "node:crypto";
import type { AccountLease, ProfileId, ProviderId } from "./types.ts";

export type AcquireLeaseResult =
  | { ok: true; lease: AccountLease; queued: false }
  | { ok: false; queued: true; reason: "max_concurrent"; profile: ProfileId; holders: number };

/**
 * In-memory account leases. Daemon-local: dropped on daemon restart (clients re-acquire).
 * Does not invent a default maxConcurrent — unlimited unless the account sets one.
 */
export class LeaseManager {
  private readonly leases = new Map<string, AccountLease>();

  list(provider?: ProviderId, profile?: ProfileId): AccountLease[] {
    return [...this.leases.values()].filter((l) => {
      if (provider && l.provider !== provider) return false;
      if (profile && l.profile !== profile) return false;
      return true;
    });
  }

  count(provider: ProviderId, profile: ProfileId): number {
    return this.list(provider, profile).length;
  }

  acquire(opts: {
    provider: ProviderId;
    profile: ProfileId;
    holder: string;
    maxConcurrent?: number;
  }): AcquireLeaseResult {
    const holders = this.count(opts.provider, opts.profile);
    if (opts.maxConcurrent !== undefined && holders >= opts.maxConcurrent) {
      return {
        ok: false,
        queued: true,
        reason: "max_concurrent",
        profile: opts.profile,
        holders,
      };
    }
    const lease: AccountLease = {
      id: randomUUID(),
      provider: opts.provider,
      profile: opts.profile,
      holder: opts.holder,
      acquiredAt: new Date().toISOString(),
    };
    this.leases.set(lease.id, lease);
    return { ok: true, lease, queued: false };
  }

  release(id: string): boolean {
    return this.leases.delete(id);
  }

  releaseHolder(holder: string): number {
    let n = 0;
    for (const [id, lease] of this.leases) {
      if (lease.holder === holder) {
        this.leases.delete(id);
        n += 1;
      }
    }
    return n;
  }
}
