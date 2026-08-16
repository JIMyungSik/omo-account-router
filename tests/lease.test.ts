import { describe, expect, test } from "bun:test";
import { LeaseManager } from "../src/lease.ts";

describe("Account leases", () => {
  test("unlimited when maxConcurrent is unset", () => {
    const m = new LeaseManager();
    const a = m.acquire({ provider: "xai", profile: "a", holder: "m1" });
    const b = m.acquire({ provider: "xai", profile: "a", holder: "m2" });
    const c = m.acquire({ provider: "xai", profile: "a", holder: "m3" });
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(m.count("xai", "a")).toBe(3);
  });

  test("maxConcurrent queues instead of inventing a default cap", () => {
    const m = new LeaseManager();
    const first = m.acquire({ provider: "anthropic", profile: "work", holder: "m1", maxConcurrent: 1 });
    const second = m.acquire({ provider: "anthropic", profile: "work", holder: "m2", maxConcurrent: 1 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("max_concurrent");
  });

  test("release frees capacity", () => {
    const m = new LeaseManager();
    const first = m.acquire({ provider: "xai", profile: "a", holder: "m1", maxConcurrent: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    m.release(first.lease.id);
    const second = m.acquire({ provider: "xai", profile: "a", holder: "m2", maxConcurrent: 1 });
    expect(second.ok).toBe(true);
  });
});
