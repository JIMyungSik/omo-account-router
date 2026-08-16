import { existsSync, readFileSync, statSync } from "node:fs";
import type { StoredCredential } from "./types.ts";

/**
 * Minimal simulation of Senpi AuthStorage.readLatestData revision check.
 * See senpi/dist/core/auth-storage.js getFileRevision + readLatestData.
 */
function getFileRevision(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  } catch {
    return undefined;
  }
}

export function simulateSenpiAuthRead(authPath: string) {
  let revision: string | undefined;
  let data: Record<string, StoredCredential> = {};

  const reload = () => {
    if (!existsSync(authPath)) {
      data = {};
      revision = undefined;
      return;
    }
    data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, StoredCredential>;
    revision = getFileRevision(authPath);
  };

  reload();

  return {
    async read(provider: string): Promise<StoredCredential | undefined> {
      const current = getFileRevision(authPath);
      if (current !== undefined && current === revision) {
        return data[provider];
      }
      reload();
      return data[provider];
    },
  };
}
