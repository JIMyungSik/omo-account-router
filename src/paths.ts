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
 * Auth.json files OAR may write (hot-switch slot).
 *
 * OMO 5.x launcher sets SENPI_CODING_AGENT_DIR=~/.omo/agent and that is the
 * live Senpi getAgentDir() path. Do not silently rewrite ~/.senpi or
 * ~/.omo/auth.json unless env / OAR_ACTIVATE_ALL=1 says so.
 */
export function resolveActiveAuthPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const envDirs = [
    env.OAR_AUTH_DIR,
    env.OMO_CODING_AGENT_DIR,
    env.SENPI_CODING_AGENT_DIR,
    env.PI_CODING_AGENT_DIR,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  if (env.OAR_AUTH_PATH) return unique([env.OAR_AUTH_PATH]);
  if (envDirs.length > 0) return unique(envDirs.map((dir) => join(dir, "auth.json")));

  const known = knownAuthJsonCandidates(home);
  if (env.OAR_ACTIVATE_ALL === "1") {
    const existing = known.filter((p) => existsSync(p));
    return existing.length > 0 ? existing : [known[0]!];
  }

  const omoAgent = join(home, ".omo", "agent", "auth.json");
  const remoteAgent = join(home, ".senpi", "remote-agent", "auth.json");
  const targets: string[] = [];
  if (existsSync(omoAgent) || existsSync(join(home, ".omo"))) targets.push(omoAgent);
  // When OmO Remote runtime exists, dual-write vault activations there too so the
  // phone path does not need a forbidden cp of native auth.json.
  if (existsSync(join(home, ".senpi", "remote-agent"))) targets.push(remoteAgent);
  if (targets.length > 0) return unique(targets);
  return [join(home, ".senpi", "agent", "auth.json")];
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
