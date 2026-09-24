import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultOarRoot } from "./paths.ts";

export type ImportAccountSetting = "primary" | "latest" | string;

function prefPath(root = defaultOarRoot()): string {
  return join(root, "import-account.json");
}

export function readImportAccountSetting(root = defaultOarRoot()): ImportAccountSetting {
  const path = prefPath(root);
  if (!existsSync(path)) return "latest";
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "primary";
    const account = (parsed as { account?: unknown }).account;
    return typeof account === "string" && account.length > 0 ? account : "latest";
  } catch {
    return "latest";
  }
}

export function writeImportAccountSetting(account: string, root = defaultOarRoot()): void {
  if (!account || account.startsWith("-")) throw new Error("import account setting must be primary, latest, or a slot name");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(prefPath(root), JSON.stringify({ account }, null, 2), { encoding: "utf8", mode: 0o600 });
}
