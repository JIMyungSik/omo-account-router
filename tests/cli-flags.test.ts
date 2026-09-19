import { describe, expect, test } from "bun:test";
import { positionalArgs, rejectUnknownFlags } from "../src/cli-flags.ts";

describe("rejectUnknownFlags", () => {
  test("allows known flags", () => {
    expect(() => rejectUnknownFlags(["--json"], new Set(["--json"]))).not.toThrow();
  });

  test("rejects unknown flags", () => {
    expect(() => rejectUnknownFlags(["--bogus"], new Set(["--json"]))).toThrow(/unknown flag/);
  });

  test("value flags consume next token", () => {
    expect(() =>
      rejectUnknownFlags(["--hours", "12"], new Set(["--hours"]), new Set(["--hours"])),
    ).not.toThrow();
    expect(() => rejectUnknownFlags(["--hours"], new Set(["--hours"]), new Set(["--hours"]))).toThrow(
      /requires a value/,
    );
  });
});

describe("positionalArgs", () => {
  test("skips flags and flag values", () => {
    expect(
      positionalArgs(["xai", "main", "--from", "/tmp/auth.json", "--force"], new Set(["--from"])),
    ).toEqual(["xai", "main"]);
  });
});
