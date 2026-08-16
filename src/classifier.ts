import type { FailureType, ProviderId } from "./types.ts";

export type FailureInput = {
  provider?: ProviderId;
  status?: number;
  body?: string;
  headers?: Record<string, string | undefined>;
  code?: string;
};

function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

/**
 * Structured-first failure classification. Prefer HTTP status + provider codes
 * over brittle stderr-only matching.
 */
export function classifyFailure(input: FailureInput): FailureType {
  const body = norm(input.body);
  const code = norm(input.code);
  const status = input.status;

  if (
    body.includes("invalid_grant") ||
    body.includes("refresh token has been revoked") ||
    body.includes("refresh_token_revoked") ||
    code === "invalid_grant"
  ) {
    return "AUTH_REVOKED";
  }

  if (
    status === 401 ||
    body.includes("unauthorized") ||
    body.includes("token expired") ||
    body.includes("auth_expired")
  ) {
    // expired vs revoked: revoked already handled; remaining 401 → expired
    if (body.includes("revok")) return "AUTH_REVOKED";
    return "AUTH_EXPIRED";
  }

  if (status === 429 || body.includes("rate limit") || body.includes("rate_limit")) {
    return "RATE_LIMITED";
  }

  if (
    status === 402 ||
    body.includes("quota") ||
    body.includes("insufficient_quota") ||
    body.includes("usage limit")
  ) {
    return "QUOTA_EXHAUSTED";
  }

  if (status === 404 || body.includes("model_not_found") || body.includes("model not found")) {
    return "MODEL_NOT_FOUND";
  }

  if (status !== undefined && status >= 500) {
    return "SERVER_ERROR";
  }

  if (status === 400) {
    return "BAD_REQUEST";
  }

  if (status === 422) {
    return "INVALID_ARGUMENT";
  }

  if (body.includes("network") || body.includes("econnreset") || body.includes("fetch failed")) {
    return "NETWORK_ERROR";
  }

  return "UNKNOWN";
}

export function isAccountFailoverCandidate(failure: FailureType): boolean {
  return (
    failure === "AUTH_REVOKED" ||
    failure === "AUTH_EXPIRED" ||
    failure === "RATE_LIMITED" ||
    failure === "QUOTA_EXHAUSTED"
  );
}
