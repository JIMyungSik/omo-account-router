import type { FailureType, ProviderId } from "./types.ts";

export type FailureInput = {
  provider?: ProviderId;
  status?: number;
  body?: string;
  headers?: Record<string, string | string[] | undefined>;
  code?: string;
};

function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

/** Flatten header bag. Senpi 2026.9+ after_provider_response is status+headers only. */
export function headerHaystack(headers?: Record<string, string | string[] | undefined>): string {
  if (!headers) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    parts.push(key, Array.isArray(value) ? value.join(" ") : String(value));
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Structured-first failure classification. Prefer HTTP status + provider codes
 * over brittle stderr-only matching. Header values are scanned because OMO/Senpi
 * 2026.9.4 after_provider_response no longer includes the response body.
 */
export function classifyFailure(input: FailureInput): FailureType {
  const body = norm(input.body);
  const headersText = headerHaystack(input.headers);
  const text = `${body} ${headersText}`.trim();
  const code = norm(input.code);
  const status = input.status;

  if (
    text.includes("invalid_grant") ||
    text.includes("refresh token has been revoked") ||
    text.includes("refresh_token_revoked") ||
    code === "invalid_grant"
  ) {
    return "AUTH_REVOKED";
  }

  if (
    status === 401 ||
    text.includes("unauthorized") ||
    text.includes("token expired") ||
    text.includes("auth_expired") ||
    text.includes("invalid_token")
  ) {
    // expired vs revoked: revoked already handled; remaining 401 → expired
    if (text.includes("revok")) return "AUTH_REVOKED";
    return "AUTH_EXPIRED";
  }

  if (status === 429 || text.includes("rate limit") || text.includes("rate_limit")) {
    return "RATE_LIMITED";
  }

  if (
    status === 402 ||
    status === 403 ||
    text.includes("quota") ||
    text.includes("insufficient_quota") ||
    text.includes("usage limit") ||
    text.includes("run out of credits") ||
    text.includes("out of credits") ||
    text.includes("need a grok subscription") ||
    text.includes("add credits") ||
    text.includes("supergrok")
  ) {
    // 403 from xAI/Grok subscription exhaustion is quota, not auth.
    return "QUOTA_EXHAUSTED";
  }

  if (status === 404 || text.includes("model_not_found") || text.includes("model not found")) {
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

  if (text.includes("network") || text.includes("econnreset") || text.includes("fetch failed")) {
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
