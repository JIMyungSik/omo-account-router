import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultOarRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OAR_HOME) return env.OAR_HOME;
  return join(homedir(), ".oar");
}

export function oarSocketPath(root = defaultOarRoot()): string {
  return join(root, "oar.sock");
}

export function oarStatePath(root = defaultOarRoot()): string {
  return join(root, "state.json");
}

export function oarVaultDir(root = defaultOarRoot()): string {
  return join(root, "vault");
}

export function oarEventsPath(root = defaultOarRoot()): string {
  return join(root, "events.jsonl");
}

function unique(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Auth.json files OAR writes on `oar use`.
 *
 * OMO windows read ~/.omo/agent/auth.json. A raw senpi window reads
 * ~/.senpi/agent/auth.json, and an older layout still reads ~/.omo/auth.json.
 * Update every one of those that already exists so another session sees the switch.
 * OAR_AUTH_PATH remains a single-file override for tests.
 */
export function resolveActiveAuthPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (env.OAR_AUTH_PATH) return unique([env.OAR_AUTH_PATH]);

  const envDirs = [
    env.OAR_AUTH_DIR,
    env.OMO_CODING_AGENT_DIR,
    env.SENPI_CODING_AGENT_DIR,
    env.PI_CODING_AGENT_DIR,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const known = knownAuthJsonCandidates(home);
  const existing = known.filter((p) => existsSync(p));
  const selected = envDirs.length > 0 ? envDirs.map((dir) => join(dir, "auth.json")) : [];
  const targets = unique([...selected, ...existing]);
  if (targets.length > 0) return targets;
  return [join(home, ".omo", "agent", "auth.json")];
}

function knownAuthJsonCandidates(home: string): string[] {
  return unique([
    join(home, ".omo", "agent", "auth.json"),
    join(home, ".omo", "auth.json"),
    join(home, ".senpi", "agent", "auth.json"),
    // OmO Remote dedicated app-server runtime (iPhone track)
    join(home, ".senpi", "remote-agent", "auth.json"),
  ]);
}

/** Read-only discovery for `oar doctor`. */
export function discoverAuthJsonFiles(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  return unique([...resolveActiveAuthPaths(env, home), ...knownAuthJsonCandidates(home)]).filter((p) =>
    existsSync(p),
  );
}
