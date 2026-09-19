import { describe, expect, test } from "bun:test";
import { loginFromXaiUserinfo, XAI_USERINFO_URL } from "../src/xai-login.ts";

const oauth = {
  type: "oauth" as const,
  access: "tok",
  refresh: "ref",
  expires: Date.now() + 3600_000,
};

describe("loginFromXaiUserinfo", () => {
  test("reads email from OIDC userinfo", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(XAI_USERINFO_URL);
      return new Response(JSON.stringify({ email: "grok@example.com", sub: "uuid" }), { status: 200 });
    };
    expect(await loginFromXaiUserinfo(oauth, { fetchImpl })).toBe("grok@example.com");
  });

  test("ignores expired tokens, non-email, and api keys", async () => {
    const expired: typeof fetch = async () => new Response("{}", { status: 401 });
    expect(await loginFromXaiUserinfo(oauth, { fetchImpl: expired })).toBeUndefined();

    const uuid: typeof fetch = async () =>
      new Response(JSON.stringify({ email: "not-an-email", sub: "uuid" }), { status: 200 });
    expect(await loginFromXaiUserinfo(oauth, { fetchImpl: uuid })).toBeUndefined();

    expect(await loginFromXaiUserinfo({ type: "api_key", key: "sk" })).toBeUndefined();
    expect(await loginFromXaiUserinfo(undefined)).toBeUndefined();
  });

  test("does not put the access token in thrown or returned values", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      expect(auth.startsWith("Bearer ")).toBe(true);
      return new Response(JSON.stringify({ email: "ok@example.com" }), { status: 200 });
    };
    const login = await loginFromXaiUserinfo(
      { ...oauth, access: "super-secret-access-token" },
      { fetchImpl },
    );
    expect(login).toBe("ok@example.com");
    expect(JSON.stringify(login)).not.toContain("super-secret");
  });
});
