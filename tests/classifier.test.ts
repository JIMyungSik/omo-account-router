import { describe, expect, test } from "bun:test";
import { classifyFailure } from "../src/classifier.ts";

describe("classifyFailure", () => {
  test("maps xAI invalid_grant refresh revoked to AUTH_REVOKED", () => {
    const result = classifyFailure({
      provider: "xai",
      status: 400,
      body: "OAuth refresh failed for xai HTTP 400 invalid_grant Refresh token has been revoked",
    });
    expect(result).toBe("AUTH_REVOKED");
  });

  test("maps 429 to RATE_LIMITED", () => {
    expect(classifyFailure({ provider: "xai", status: 429, headers: { "retry-after": "60" } })).toBe(
      "RATE_LIMITED",
    );
  });

  test("does not failover-classify BAD_REQUEST", () => {
    expect(classifyFailure({ provider: "xai", status: 400, body: "invalid model id" })).toBe(
      "BAD_REQUEST",
    );
  });
});
