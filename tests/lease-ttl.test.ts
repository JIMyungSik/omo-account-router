import { describe, expect, test } from "bun:test";
import { DEFAULT_LEASE_TTL_MS, LeaseManager } from "../src/lease.ts";

describe("lease TTL", () => {
  test("expired leases are swept and free capacity", () => {
    const leases = new LeaseManager({ ttlMs: 1000 });
    const a = leases.acquire({ provider: "xai", profile: "main", holder: "h1", maxConcurrent: 1 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // force expiry
    (a.lease as { acquiredAt: string }).acquiredAt = new Date(Date.now() - 10_000).toISOString();
    const b = leases.acquire({ provider: "xai", profile: "main", holder: "h2", maxConcurrent: 1 });
    expect(b.ok).toBe(true);
    expect(leases.list().length).toBe(1);
    expect(leases.list()[0]?.holder).toBe("h2");
  });

  test("default TTL is 2h", () => {
    expect(DEFAULT_LEASE_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });
});
