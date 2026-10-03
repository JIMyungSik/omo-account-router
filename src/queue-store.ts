import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./json-file.ts";
import { defaultOarRoot, oarQueueDir, oarQueuePath } from "./paths.ts";

export type QueueTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "incomplete";

export type QueueVerdict = "completed" | "incomplete" | "failed";

export const QUEUE_ISOLATION_STRATEGIES = ["worktree", "none"] as const;
export type QueueIsolationStrategy = (typeof QUEUE_ISOLATION_STRATEGIES)[number];
export const DEFAULT_QUEUE_ISOLATION: QueueIsolationStrategy = "worktree";
export const DEFAULT_QUEUE_MAX_ATTEMPTS = 3;

export function isQueueIsolation(value: unknown): value is QueueIsolationStrategy {
  return typeof value === "string" && (QUEUE_ISOLATION_STRATEGIES as readonly string[]).includes(value);
}

export function parseQueueIsolation(value: unknown): QueueIsolationStrategy {
  if (value == null || value === "") return DEFAULT_QUEUE_ISOLATION;
  if (isQueueIsolation(value)) return value;
  throw new Error(`unknown isolation strategy: ${String(value)} (use worktree or none)`);
}

export function parseMaxAttempts(value: unknown): number {
  if (value == null || value === "") return DEFAULT_QUEUE_MAX_ATTEMPTS;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("maxAttempts must be an integer >= 1");
  }
  return n;
}

export type QueueSessionMode = "resume" | "fresh";

export type QueueAttemptCause =
  | "done"
  | "incomplete_sentinel"
  | "brake_paused"
  | "provider_error"
  | "missing_sentinel"
  | "exit"
  | "signal";

export type QueueAttemptRecord = {
  attempt: number;
  sessionId?: string;
  sessionMode: QueueSessionMode;
  cause: QueueAttemptCause;
  verdict: QueueVerdict;
  reason: string;
  artifactDir: string;
  startedAt: string;
  finishedAt: string;
};

export function inferAttemptCause(record: {
  cause?: QueueAttemptCause;
  verdict?: QueueVerdict;
  reason?: string;
}): QueueAttemptCause | undefined {
  if (record.cause) return record.cause;
  if (record.verdict === "completed") return "done";
  if (record.reason === "missing_sentinel") return "missing_sentinel";
  if (record.reason === "omo-brake paused" || record.reason?.startsWith("omo-brake paused")) {
    return "brake_paused";
  }
  if (record.reason?.startsWith("provider_error")) return "provider_error";
  if (record.reason?.startsWith("signal:")) return "signal";
  if (record.reason?.startsWith("exit:")) return "exit";
  if (record.verdict === "incomplete") return "incomplete_sentinel";
  if (record.verdict === "failed") return "exit";
  return undefined;
}

export function shouldResumeQueueSession(previous?: {
  cause?: QueueAttemptCause;
  verdict?: QueueVerdict;
  reason?: string;
}): boolean {
  return inferAttemptCause(previous ?? {}) === "incomplete_sentinel";
}

export type QueueTask = {
  id: string;
  prompt: string;
  repository: string;
  isolation: QueueIsolationStrategy;
  status: QueueTaskStatus;
  maxAttempts: number;
  attempts: number;
  sessionIds: string[];
  attemptHistory: QueueAttemptRecord[];
  dependsOn: string[];
  verdict?: QueueVerdict;
  reason?: string;
  worktreeDir?: string;
  artifactDir?: string;
  output?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
};

export type QueueDependencyGate = {
  dependsOn: string[];
  unmetDependsOn: string[];
  waiting: boolean;
  ready: boolean;
  reason?: string;
};

export type QueueTaskView = QueueTask & QueueDependencyGate;

export function parseDependsOn(value: unknown): string[] {
  if (value == null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const id = String(item).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function resolveQueueTaskRef(tasks: readonly QueueTask[], ref: string): QueueTask {
  const token = ref.trim();
  if (!token) throw new Error("queue task id is required");
  const exact = tasks.find((task) => task.id === token);
  if (exact) return exact;
  const matches = tasks.filter((task) => task.id.startsWith(token));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`ambiguous queue task id prefix: ${token}`);
  throw new Error(`unknown queue task ${token}`);
}

export function resolveDependsOn(
  value: unknown,
  tasks: readonly QueueTask[],
  selfId?: string,
): string[] {
  const refs = parseDependsOn(value);
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (selfId && ref === selfId) throw new Error("cannot depend on itself");
    const task = resolveQueueTaskRef(tasks, ref);
    if (selfId && task.id === selfId) throw new Error("cannot depend on itself");
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    resolved.push(task.id);
  }
  return resolved;
}

export type QueueFile = {
  version: 1;
  tasks: QueueTask[];
  updatedAt: string;
};

const TERMINAL: ReadonlySet<QueueTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "incomplete",
]);

export function isTerminalQueueStatus(status: QueueTaskStatus): boolean {
  return TERMINAL.has(status);
}

export function isSuccessfulQueueCompletion(task: QueueTask | undefined): boolean {
  return task?.status === "completed" && task.verdict === "completed";
}

export function evaluateQueueDependencies(
  task: Pick<QueueTask, "dependsOn">,
  tasks: readonly QueueTask[],
): QueueDependencyGate {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  const unmetDependsOn: string[] = [];
  const reasons: string[] = [];
  for (const id of dependsOn) {
    const dep = byId.get(id);
    if (isSuccessfulQueueCompletion(dep)) continue;
    unmetDependsOn.push(id);
    if (!dep) {
      reasons.push(`unsatisfiable_dependency: ${id} (unknown)`);
      continue;
    }
    if (isTerminalQueueStatus(dep.status) && dep.status !== "completed") {
      reasons.push(`unsatisfiable_dependency: ${id} (${dep.status})`);
      continue;
    }
    reasons.push(`unmet_dependency: ${id} (${dep.status})`);
  }
  return {
    dependsOn,
    unmetDependsOn,
    waiting: unmetDependsOn.length > 0,
    ready: unmetDependsOn.length === 0,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
  };
}

export function annotateQueueTask(task: QueueTask, tasks: readonly QueueTask[]): QueueTaskView {
  return { ...task, ...evaluateQueueDependencies(task, tasks) };
}

export function annotateQueueTasks(tasks: readonly QueueTask[]): QueueTaskView[] {
  return tasks.map((task) => annotateQueueTask(task, tasks));
}

export function formatQueueListText(tasks: readonly QueueTaskView[]): string {
  if (tasks.length === 0) return "(empty queue)";
  return tasks
    .map((task) => {
      const short = task.id.slice(0, 8);
      const parts = [short, task.status, `${task.attempts}/${task.maxAttempts}`];
      if (task.dependsOn.length > 0) {
        parts.push(`dependsOn=${task.dependsOn.map((id) => id.slice(0, 8)).join(",")}`);
      }
      if (task.waiting) {
        parts.push(`waiting unmet=${task.unmetDependsOn.map((id) => id.slice(0, 8)).join(",")}`);
        if (task.reason) parts.push(task.reason);
      }
      return parts.join("  ");
    })
    .join("\n");
}

export function isDependencyWaitReason(reason: string | undefined): boolean {
  return (
    typeof reason === "string" &&
    (reason.startsWith("unmet_dependency:") || reason.startsWith("unsatisfiable_dependency:"))
  );
}

export class QueueStore {
  readonly rootDir: string;
  private readonly path: string;

  constructor(opts?: { rootDir?: string }) {
    this.rootDir = opts?.rootDir ?? defaultOarRoot();
    this.path = oarQueuePath(this.rootDir);
  }

  artifactDir(id: string): string {
    return join(oarQueueDir(this.rootDir), id);
  }

  attemptArtifactDir(id: string, attempt: number): string {
    return join(this.artifactDir(id), `attempt-${attempt}`);
  }

  list(): QueueTask[] {
    return this.load().tasks.map((task) => ({ ...task }));
  }

  get(id: string): QueueTask | undefined {
    const task = this.load().tasks.find((item) => item.id === id);
    return task ? { ...task } : undefined;
  }

  resolve(ref: string): QueueTask {
    return { ...resolveQueueTaskRef(this.list(), ref) };
  }

  nextQueued(): QueueTask | undefined {
    return this.listQueued()[0];
  }

  listQueued(): QueueTask[] {
    return this.list()
      .filter((task) => task.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  add(input: {
    prompt: string;
    repository: string;
    isolation?: QueueIsolationStrategy;
    maxAttempts?: number;
    dependsOn?: string[];
    nowMs: number;
  }): QueueTask {
    const prompt = input.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("prompt must be a non-empty string");
    }
    if (!input.repository) throw new Error("repository is required");
    const isolation = parseQueueIsolation(input.isolation);
    const maxAttempts = parseMaxAttempts(input.maxAttempts);
    const data = this.load();
    const id = crypto.randomUUID();
    const dependsOn = resolveDependsOn(input.dependsOn, data.tasks, id);
    const task: QueueTask = {
      id,
      prompt,
      repository: input.repository,
      isolation,
      status: "queued",
      maxAttempts,
      attempts: 0,
      sessionIds: [],
      attemptHistory: [],
      dependsOn,
      createdAt: new Date(input.nowMs).toISOString(),
      artifactDir: this.artifactDir(id),
    };
    data.tasks.push(task);
    this.save(data);
    return { ...task };
  }

  update(
    id: string,
    patch: Partial<Omit<QueueTask, "id" | "prompt" | "repository" | "createdAt" | "isolation">>,
  ): QueueTask {
    const data = this.load();
    const idx = data.tasks.findIndex((task) => task.id === id);
    if (idx < 0) throw new Error(`unknown queue task ${id}`);
    const current = data.tasks[idx]!;
    const next: QueueTask = { ...current, ...patch, id: current.id };
    data.tasks[idx] = next;
    this.save(data);
    return { ...next };
  }

  rearm(id: string): QueueTask {
    const task = this.get(id);
    if (!task) throw new Error(`unknown queue task ${id}`);
    if (task.status !== "incomplete" && task.status !== "failed") {
      throw new Error(`cannot retry ${id} (${task.status})`);
    }
    return this.update(id, {
      status: "queued",
      attempts: 0,
      finishedAt: undefined,
      error: undefined,
      verdict: undefined,
      reason: undefined,
    });
  }

  markStaleRunning(nowMs: number): QueueTask[] {
    const data = this.load();
    const interrupted: QueueTask[] = [];
    const finishedAt = new Date(nowMs).toISOString();
    data.tasks = data.tasks.map((task) => {
      if (task.status !== "running") return task;
      const next: QueueTask = {
        ...task,
        status: "interrupted",
        finishedAt,
        error: task.error ?? "daemon_restart",
        reason: task.reason ?? "daemon_restart",
      };
      interrupted.push({ ...next });
      return next;
    });
    if (interrupted.length > 0) this.save(data);
    return interrupted;
  }

  private load(): QueueFile {
    if (!existsSync(this.path)) {
      return { version: 1, tasks: [], updatedAt: new Date(0).toISOString() };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<QueueFile>;
      if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) {
        return { version: 1, tasks: [], updatedAt: new Date(0).toISOString() };
      }
      return {
        version: 1,
        tasks: parsed.tasks
          .filter((task): task is QueueTask => Boolean(task?.id && task.prompt && task.repository))
          .map((task) => normalizeLoadedTask(task)),
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      };
    } catch {
      return { version: 1, tasks: [], updatedAt: new Date(0).toISOString() };
    }
  }

  private save(data: QueueFile): void {
    atomicWriteJson(this.path, { ...data, updatedAt: new Date().toISOString() }, 0o600);
  }
}

function normalizeAttemptRecord(item: QueueAttemptRecord): QueueAttemptRecord {
  const cause = inferAttemptCause(item);
  const sessionMode: QueueSessionMode = item.sessionMode === "resume" ? "resume" : "fresh";
  return {
    ...item,
    sessionMode,
    ...(cause ? { cause } : { cause: "missing_sentinel" }),
  };
}

function normalizeLoadedTask(task: QueueTask): QueueTask {
  const sessionIds = Array.isArray(task.sessionIds)
    ? task.sessionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const attemptHistory = Array.isArray(task.attemptHistory)
    ? task.attemptHistory
        .filter((item) => item && typeof item.attempt === "number")
        .map((item) => normalizeAttemptRecord(item))
    : [];
  let maxAttempts = DEFAULT_QUEUE_MAX_ATTEMPTS;
  try {
    maxAttempts = parseMaxAttempts(task.maxAttempts);
  } catch {
    maxAttempts = DEFAULT_QUEUE_MAX_ATTEMPTS;
  }
  return {
    ...task,
    isolation: isQueueIsolation(task.isolation) ? task.isolation : DEFAULT_QUEUE_ISOLATION,
    maxAttempts,
    attempts: Number.isInteger(task.attempts) && (task.attempts ?? 0) >= 0 ? Number(task.attempts) : 0,
    sessionIds,
    attemptHistory,
    dependsOn: parseDependsOn(task.dependsOn),
  };
}
