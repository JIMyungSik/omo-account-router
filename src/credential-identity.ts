import type { StoredCredential } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unsigned or signed JWT payload only. Never logs the token. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = Buffer.from(padded + pad, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const OPENAI_PROFILE = "https://api.openai.com/profile";

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function emailFromUnknown(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return looksLikeEmail(trimmed) ? trimmed : undefined;
}

function emailFromJwtPayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const nested = payload[OPENAI_PROFILE];
  if (isRecord(nested)) {
    const fromProfile = emailFromUnknown(nested.email);
    if (fromProfile) return fromProfile;
  }
  return emailFromUnknown(payload.email) ?? emailFromUnknown(payload.preferred_username);
}

/** Human PROFILE cell: `main(user@example.com)` when login is an email. */
export function formatProfileLabel(profile: string, login?: string | null): string {
  return login ? `${profile}(${login})` : profile;
}

/**
 * Vault login label for display only. Accepts JWT email claims, never UUID/sub/accountId.
 */
export function loginFromCredential(cred: StoredCredential | undefined): string | undefined {
  if (!cred || cred.type !== "oauth") return undefined;
  if (cred.idToken) {
    const fromId = emailFromJwtPayload(decodeJwtPayload(cred.idToken));
    if (fromId) return fromId;
  }
  return emailFromJwtPayload(decodeJwtPayload(cred.access));
}

/** Stable OAuth subject for same-account comparisons. Never returns or logs token bytes. */
export function subjectFromCredential(cred: StoredCredential | undefined): string | undefined {
  if (!cred || cred.type !== "oauth") return undefined;
  const subject = decodeJwtPayload(cred.access)?.sub;
  return typeof subject === "string" && subject.length > 0 ? subject : undefined;
}
