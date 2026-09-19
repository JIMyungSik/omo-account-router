import { describe, expect, test } from "bun:test";
import {
  formatProfileLabel,
  loginFromCredential,
} from "../src/credential-identity.ts";
import type { StoredCredential } from "../src/types.ts";

function unsignedJwt(payload: Record<string, unknown>): string {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${json}.`;
}

function oauth(partial: Partial<Extract<StoredCredential, { type: "oauth" }>>): StoredCredential {
  return {
    type: "oauth",
    access: "opaque",
    refresh: "opaque-refresh",
    expires: Date.now() + 60_000,
    ...partial,
  };
}

describe("loginFromCredential", () => {
  test("reads email from idToken", () => {
    const cred = oauth({
      idToken: unsignedJwt({ email: "id@example.com", sub: "google-oauth2|123" }),
    });
    expect(loginFromCredential(cred)).toBe("id@example.com");
  });

  test("reads nested Codex profile email from access JWT", () => {
    const cred = oauth({
      access: unsignedJwt({
        sub: "user-uuid-not-an-email",
        "https://api.openai.com/profile": { email: "codex@example.com", name: "Ada" },
      }),
    });
    expect(loginFromCredential(cred)).toBe("codex@example.com");
  });

  test("idToken email wins over access", () => {
    const cred = oauth({
      idToken: unsignedJwt({ email: "id@example.com" }),
      access: unsignedJwt({
        "https://api.openai.com/profile": { email: "access@example.com" },
      }),
    });
    expect(loginFromCredential(cred)).toBe("id@example.com");
  });

  test("ignores UUID sub, accountId, and opaque tokens", () => {
    expect(
      loginFromCredential(
        oauth({
          access: unsignedJwt({ sub: "334a4c6d-ddbe-4078-b582-9df7bb695482" }),
          accountId: "8b8d301e-942f-4e99-84a6-8a4cc0551700",
        }),
      ),
    ).toBeUndefined();
    expect(loginFromCredential(oauth({ access: "not-a-jwt" }))).toBeUndefined();
    expect(loginFromCredential({ type: "api_key", key: "sk-test" })).toBeUndefined();
    expect(loginFromCredential(undefined)).toBeUndefined();
  });
});

describe("formatProfileLabel", () => {
  test("appends email in parentheses", () => {
    expect(formatProfileLabel("main", "user@example.com")).toBe("main(user@example.com)");
    expect(formatProfileLabel("main")).toBe("main");
    expect(formatProfileLabel("main", null)).toBe("main");
  });
});
