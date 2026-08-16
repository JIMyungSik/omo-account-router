import { findSenpiInstall } from "./senpi-install.ts";
import type { StoredCredential } from "./types.ts";

export type SenpiAuthStorage = {
  read(provider: string): Promise<StoredCredential | undefined>;
  modify(
    provider: string,
    fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
  ): Promise<StoredCredential | undefined>;
};

type AuthStorageCtor = {
  create(authPath: string): SenpiAuthStorage;
};

let cached: AuthStorageCtor | null | undefined;

/**
 * Load Senpi's real AuthStorage class from the installed omo-ai engine.
 * Used so OAR slot writes take the same file lock as running OMO/Senpi.
 */
export async function loadSenpiAuthStorageClass(): Promise<AuthStorageCtor | null> {
  if (cached !== undefined) return cached;
  const install = findSenpiInstall();
  if (!install) {
    cached = null;
    return null;
  }
  try {
    const mod = (await import(install.authStoragePath)) as { AuthStorage?: AuthStorageCtor };
    if (!mod.AuthStorage?.create) {
      cached = null;
      return null;
    }
    cached = mod.AuthStorage;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export async function createSenpiAuthStorage(authPath: string): Promise<SenpiAuthStorage | null> {
  const ctor = await loadSenpiAuthStorageClass();
  if (!ctor) return null;
  return ctor.create(authPath);
}
