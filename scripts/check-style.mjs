#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["src", "tests", "extensions"];
const banned = [
  { re: /\bas any\b/, label: "as any" },
  { re: /@ts-ignore\b/, label: "@ts-ignore" },
  { re: /@ts-expect-error\b/, label: "@ts-expect-error" },
];

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) files(path, out);
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const problems = [];
for (const root of roots) {
  for (const path of files(root)) {
    const text = readFileSync(path, "utf8");
    for (const rule of banned) {
      if (rule.re.test(text)) problems.push(`${path}: ${rule.label}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("style: ok");
