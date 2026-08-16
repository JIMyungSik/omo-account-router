#!/usr/bin/env node
/**
 * npm/global entry. Runs packaged dist/cli.js with the current Node (or Bun) binary.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "dist", "cli.js");
const cliTs = join(root, "src", "cli.ts");

const entry = existsSync(cli) ? cli : existsSync(cliTs) ? cliTs : null;
if (!entry) {
  console.error("oar: dist/cli.js not found. Reinstall package or run: npm run build");
  process.exit(1);
}

const runtime = process.execPath;
const child = spawn(runtime, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
