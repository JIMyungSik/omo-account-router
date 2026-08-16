#!/usr/bin/env bun
import { OarDaemon } from "./daemon.ts";
import { defaultOarRoot, oarSocketPath, resolveActiveAuthPaths } from "./paths.ts";
import { OarStore } from "./store.ts";

const root = process.env.OAR_HOME ?? defaultOarRoot();
const socketPath = process.env.OAR_SOCK ?? oarSocketPath(root);
const store = new OarStore({ rootDir: root });
const daemon = new OarDaemon({
  store,
  socketPath,
  authPaths: resolveActiveAuthPaths(),
  activateOnUse: true,
});

async function main() {
  await daemon.start();
  console.log(`oar-daemon listening on ${socketPath}`);
  console.log(`auth paths: ${resolveActiveAuthPaths().join(", ")}`);

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
