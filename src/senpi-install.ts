import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SenpiInstall = {
  omoAiVersion: string;
  senpiVersion: string;
  omoAiRoot: string;
  senpiRoot: string;
  authStoragePath: string;
  pluginRoot: string;
};

const KNOWN_OMO = "/opt/homebrew/lib/node_modules/omo-ai";

function readJson(path: string): { name?: string; version?: string } {
  return JSON.parse(readFileSync(path, "utf8")) as { name?: string; version?: string };
}

function fromOmoRoot(omoRoot: string): SenpiInstall | null {
  const omoPkg = join(omoRoot, "package.json");
  const senpiRoot = join(omoRoot, "node_modules", "@code-yeongyu", "senpi");
  const senpiPkg = join(senpiRoot, "package.json");
  const authStoragePath = join(senpiRoot, "dist", "core", "auth-storage.js");
  const pluginRoot = join(omoRoot, "plugin");
  if (!existsSync(omoPkg) || !existsSync(senpiPkg) || !existsSync(authStoragePath)) return null;
  const omo = readJson(omoPkg);
  const senpi = readJson(senpiPkg);
  return {
    omoAiVersion: omo.version ?? "unknown",
    senpiVersion: senpi.version ?? "unknown",
    omoAiRoot: omoRoot,
    senpiRoot,
    authStoragePath,
    pluginRoot,
  };
}

/**
 * Locate the active omo-ai 5.x + nested Senpi install. Never guesses a source tree.
 */
export function findSenpiInstall(): SenpiInstall | null {
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];

  try {
    candidates.push(dirname(require.resolve("omo-ai/package.json")));
  } catch {
    // not in this package's node_modules
  }

  candidates.push(KNOWN_OMO);
  const homebrew = join(homedir(), ".nvm", "versions");
  if (existsSync(homebrew)) {
    // ignore; KNOWN_OMO covers the verified PATH install
  }

  for (const root of candidates) {
    const found = fromOmoRoot(root);
    if (found) return found;
  }
  return null;
}
