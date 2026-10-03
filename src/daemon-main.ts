#!/usr/bin/env bun
import { OarDaemon } from "./daemon.ts";
import { defaultOarRoot, oarSocketPath, resolveActiveAuthPaths } from "./paths.ts";
import { OarStore } from "./store.ts";

const root = process.env.OAR_HOME ?? defaultOarRoot();
const socketPath = process.env.OAR_SOCK ?? oarSocketPath(root);
const store = new OarStore({ rootDir: root });
const quotaPollSeconds = Number(process.env.OAR_QUOTA_POLL_SEC ?? "60");
if (!Number.isFinite(quotaPollSeconds) || quotaPollSeconds < 0) {
  throw new Error("OAR_QUOTA_POLL_SEC must be a non-negative number");
}
const omoBin = process.env.OAR_OMO_BIN ?? "omo";
const daemon = new OarDaemon({
  store,
  socketPath,
  authPaths: resolveActiveAuthPaths(),
  activateOnUse: true,
  quotaPollIntervalMs: quotaPollSeconds * 1000,
  omoCommand: { bin: omoBin },
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
