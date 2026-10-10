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

/**
 * Pull `--watch [sec]` out of `args`. Returns the refresh interval in seconds
 * (0 when --watch is absent) and the remaining args. A missing or invalid value
 * falls back to `defaultSec`; values below `minSec` are raised to it.
 */
export function extractWatchFlag(
  args: readonly string[],
  opts: { defaultSec: number; minSec: number },
): { intervalSec: number; args: string[] } {
  const idx = args.indexOf("--watch");
  if (idx < 0) return { intervalSec: 0, args: [...args] };
  const next = args[idx + 1];
  const hasValue = next !== undefined && !next.startsWith("--");
  const parsed = hasValue ? Number(next) : Number.NaN;
  const sec = Number.isFinite(parsed) && parsed > 0 ? parsed : opts.defaultSec;
  const rest = args.filter((_, i) => i !== idx && !(hasValue && i === idx + 1));
  return { intervalSec: Math.max(sec, opts.minSec), args: rest };
}
