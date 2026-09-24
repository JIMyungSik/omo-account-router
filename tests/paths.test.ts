import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveActiveAuthPaths } from "../src/paths.ts";

describe("resolveActiveAuthPaths", () => {
  let home: string;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("includes every existing local auth.json so other windows see oar use", () => {
    home = mkdtempSync(join(tmpdir(), "oar-paths-"));
    const files = [
      join(home, ".omo", "agent", "auth.json"),
      join(home, ".omo", "auth.json"),
      join(home, ".senpi", "agent", "auth.json"),
    ];
    for (const file of files) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "{}");
    }
    const paths = resolveActiveAuthPaths({ OMO_CODING_AGENT_DIR: join(home, ".omo", "agent") }, home);
    expect(paths).toEqual(files);
  });
});
