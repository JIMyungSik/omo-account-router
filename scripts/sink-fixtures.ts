/** Deterministic unsigned JWTs for tests/smoke only. Production never mints these. */
export const FIXTURE_EXP_SEC = 4_102_444_800; // 2100-01-01T00:00:00Z

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

export function fakeCodexTokens(opts: {
  accountId: string;
  access?: string;
  refresh?: string;
  expSec?: number;
  email?: string;
}): {
  access: string;
  refresh: string;
  idToken: string;
  expires: number;
  accountId: string;
} {
  const expSec = opts.expSec ?? FIXTURE_EXP_SEC;
  const access =
    opts.access ??
    fakeJwt({
      exp: expSec,
      https: "api.openai.com",
    });
  const idToken = fakeJwt({
    exp: expSec,
    email: opts.email ?? "dev@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: opts.accountId },
  });
  return {
    access,
    refresh: opts.refresh ?? `refresh-${opts.accountId}`,
    idToken,
    expires: expSec * 1000,
    accountId: opts.accountId,
  };
}

export function nativeCodexAuthJson(tokens: {
  access: string;
  refresh: string;
  idToken: string;
  accountId: string;
}): string {
  return `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.access,
        refresh_token: tokens.refresh,
        account_id: tokens.accountId,
      },
      last_refresh: "2026-01-01T00:00:00.000Z",
      extra_keep: "yes",
    },
    null,
    2,
  )}\n`;
}
