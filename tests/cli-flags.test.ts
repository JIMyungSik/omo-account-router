import { describe, expect, test } from "bun:test";
import { extractWatchFlag, positionalArgs, rejectUnknownFlags } from "../src/cli-flags.ts";

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

describe("extractWatchFlag", () => {
  const opts = { defaultSec: 30, minSec: 10 };

  test("is off without --watch", () => {
    expect(extractWatchFlag(["xai", "main"], opts)).toEqual({ intervalSec: 0, args: ["xai", "main"] });
  });

  test("uses the default when no value follows", () => {
    expect(extractWatchFlag(["--watch"], opts)).toEqual({ intervalSec: 30, args: [] });
    expect(extractWatchFlag(["--watch", "--refresh"], opts)).toEqual({ intervalSec: 30, args: ["--refresh"] });
  });

  test("consumes a numeric value and keeps the other args", () => {
    expect(extractWatchFlag(["xai", "--watch", "45", "main"], opts)).toEqual({
      intervalSec: 45,
      args: ["xai", "main"],
    });
  });

  test("raises too-small values to the minimum and ignores invalid ones", () => {
    expect(extractWatchFlag(["--watch", "2"], opts).intervalSec).toBe(10);
    expect(extractWatchFlag(["--watch", "abc"], opts)).toEqual({ intervalSec: 30, args: [] });
  });
});
