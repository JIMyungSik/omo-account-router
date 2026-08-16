import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { oarEventsPath } from "./paths.ts";

export type OarEvent = {
  ts: string;
  event: string;
  provider?: string;
  profile?: string;
  member?: string;
  holder?: string;
  reason?: string;
  pid?: number;
  latencyMs?: number;
};

const SECRET_KEYS = /access|refresh|token|authorization|api[_-]?key|secret|password/i;

function scrub(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 24 && SECRET_KEYS.test(value)) return "[redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(v);
    }
    return out;
  }
  return value;
}

export class EventLog {
  constructor(private readonly path: string) {}

  static forRoot(root: string): EventLog {
    return new EventLog(oarEventsPath(root));
  }

  append(event: OarEvent): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const line = JSON.stringify(scrub({ ...event, ts: event.ts || new Date().toISOString() })) + "\n";
    const existed = existsSync(this.path);
    appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
    if (!existed) {
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // ignore
      }
    }
  }
}
