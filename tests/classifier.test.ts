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

test("classifyFailure > maps xAI 403 out of credits to QUOTA_EXHAUSTED", () => {
  expect(
    classifyFailure({
      provider: "xai",
      status: 403,
      body: 'You have run out of credits or need a Grok subscription. Add credits at https://grok.com/',
    }),
  ).toBe("QUOTA_EXHAUSTED");
});

test("classifyFailure > header-only invalid_grant is AUTH_REVOKED (no body)", () => {
  expect(
    classifyFailure({
      provider: "xai",
      status: 400,
      headers: { "www-authenticate": 'Bearer error="invalid_grant"' },
    }),
  ).toBe("AUTH_REVOKED");
});

test("classifyFailure > header-only invalid_token is AUTH_EXPIRED", () => {
  expect(
    classifyFailure({
      provider: "openai-codex",
      status: 401,
      headers: { "www-authenticate": 'Bearer error="invalid_token"' },
    }),
  ).toBe("AUTH_EXPIRED");
});

test("classifyFailure > 400 with empty headers stays BAD_REQUEST", () => {
  expect(classifyFailure({ provider: "xai", status: 400 })).toBe("BAD_REQUEST");
});
