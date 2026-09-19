import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReportResult } from "../src/report-results.ts";
import { OarStore } from "../src/store.ts";
import { OarRouter } from "../src/router.ts";

describe("parseReportResult", () => {
  test("accepts SUCCESS and known failure types", () => {
    expect(parseReportResult("SUCCESS")).toBe("SUCCESS");
    expect(parseReportResult("AUTH_EXPIRED")).toBe("AUTH_EXPIRED");
    expect(parseReportResult("NETWORK_ERROR")).toBe("NETWORK_ERROR");
  });

  test("rejects arbitrary strings", () => {
    expect(() => parseReportResult("FOO")).toThrow(/invalid report result/i);
  });
});

describe("reportResult unknown account", () => {
  test("returns undefined when account missing", () => {
    const root = mkdtempSync(join(tmpdir(), "oar-report-"));
    const store = new OarStore({ rootDir: root });
    const router = new OarRouter(store);
    expect(
      router.reportResult({ provider: "xai", account: "missing", result: "SUCCESS" }),
    ).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
