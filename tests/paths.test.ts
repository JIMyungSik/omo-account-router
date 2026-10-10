import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNamedPipePath, oarPidPath, oarSocketPath, resolveActiveAuthPaths } from "../src/paths.ts";

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

describe("oarSocketPath", () => {
  test("uses a socket file under the root on POSIX", () => {
    const sock = oarSocketPath("/home/u/.oar", "linux");
    expect(sock).toBe(join("/home/u/.oar", "oar.sock"));
    expect(isNamedPipePath(sock)).toBe(false);
    expect(oarPidPath(sock, "/home/u/.oar")).toBe(`${sock}.pid`);
  });

  test("uses a stable per-root named pipe on Windows, with the pid file under the root", () => {
    const sock = oarSocketPath("C:\\Users\\u\\.oar", "win32");
    expect(isNamedPipePath(sock)).toBe(true);
    expect(sock).toMatch(/^\\\\\.\\pipe\\oar-[0-9a-f]{12}$/);
    expect(oarSocketPath("c:\\users\\u\\.oar", "win32")).toBe(sock);
    expect(oarSocketPath("D:\\other\\.oar", "win32")).not.toBe(sock);
    expect(oarPidPath(sock, "C:\\Users\\u\\.oar")).toBe(join("C:\\Users\\u\\.oar", "oar.pid"));
  });
});
