import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentialFromAuthJson } from "../src/import-all.ts";

describe("readCredentialFromAuthJson --account (multi-login accounts[])", () => {
  const dir = mkdtempSync(join(tmpdir(), "oar-acct-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      xai: {
        type: "oauth",
        access: "primary-token",
        refresh: "primary-refresh",
        expires: 1790000000000,
        accounts: [
          { type: "oauth", access: "primary-token", refresh: "primary-refresh", expires: 1790000000000, name: "default" },
          { type: "oauth", access: "google-token", refresh: "google-refresh", expires: 1790000000000, name: "login-2" },
          { type: "oauth", access: "apple-token", refresh: "apple-refresh", expires: 1790001000000, name: "login-3" },
        ],
      },
    }),
  );

  test("default uses the latest login-N slot", () => {
    const c = readCredentialFromAuthJson(authPath, "xai");
    expect(c.type === "oauth" && c.access === "apple-token").toBe(true);
  });

  test("primary override keeps the top-level credential", () => {
    const c = readCredentialFromAuthJson(authPath, "xai", { account: "primary" });
    expect(c.type === "oauth" && c.access === "primary-token").toBe(true);
  });

  test("--account by 1-based index picks the linked account", () => {
    const c = readCredentialFromAuthJson(authPath, "xai", { account: "3" });
    expect(c.type === "oauth" && c.access === "apple-token").toBe(true);
  });

  test("--account by name picks the linked account", () => {
    const c = readCredentialFromAuthJson(authPath, "xai", { account: "login-2" });
    expect(c.type === "oauth" && c.access === "google-token").toBe(true);
  });

  test("unknown account errors and lists available names", () => {
    expect(() => readCredentialFromAuthJson(authPath, "xai", { account: "login-9" })).toThrow(/available: 1=default, 2=login-2, 3=login-3/);
  });

  test("missing provider still errors", () => {
    expect(() => readCredentialFromAuthJson(authPath, "anthropic")).toThrow(/not found/);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
