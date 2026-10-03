import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function atomicWriteJson(path: string, data: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    // best effort on platforms without chmod
  }
}
