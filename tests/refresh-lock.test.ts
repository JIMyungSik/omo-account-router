import { describe, expect, test } from "bun:test";
import { AccountRefreshLock } from "../src/refresh-lock.ts";

describe("OAuth refresh concurrency lock", () => {
  test("10 concurrent refresh needs execute refresh once", async () => {
    const lock = new AccountRefreshLock();
    let refreshCalls = 0;
    let seq = 0;

    const refresh = async () => {
      refreshCalls += 1;
      await Bun.sleep(20);
      seq += 1;
      return { token: `t-${seq}` };
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => lock.withLock("xai:account-a", refresh)),
    );

    expect(refreshCalls).toBe(1);
    expect(new Set(results.map((r) => r.token)).size).toBe(1);
    expect(results[0]?.token).toBe("t-1");
  });
});
