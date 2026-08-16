import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const rel of ["dist/cli.js", "dist/daemon-main.js"]) {
  const path = join(root, rel);
  let text = readFileSync(path, "utf8");
  text = text.replace(/^#!.*\n/, "");
  text = "#!/usr/bin/env node\n" + text;
  writeFileSync(path, text, "utf8");
  try {
    chmodSync(path, 0o755);
  } catch {
    // ignore
  }
  console.log("shebang node:", rel);
}
