/** Reject CLI flags not in `allowed`. Flags listed in `valueFlags` consume the next token. */
export function rejectUnknownFlags(
  args: readonly string[],
  allowed: ReadonlySet<string>,
  valueFlags: ReadonlySet<string> = new Set(),
): void {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) continue;
    if (valueFlags.has(token)) {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`flag ${token} requires a value`);
      }
      i++;
      continue;
    }
    if (!allowed.has(token)) {
      throw new Error(`unknown flag: ${token}`);
    }
  }
}

/** Positional args only — tokens that are not flags or flag values. */
export function positionalArgs(
  args: readonly string[],
  valueFlags: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith("--")) {
      if (valueFlags.has(token)) i++;
      continue;
    }
    out.push(token);
  }
  return out;
}
