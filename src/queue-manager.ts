import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInPromotionWindow, promotionalModelSelector, type PromotionSchedule } from "./promotion.ts";
import {
  addIsolatedWorktree,
  inspectRepository,
  inspectRepositoryPath,
  judgeQueueRun,
  OAR_BRAKE_EXHAUSTED_REASON,
  setupFailureMessage,
  writeSetupFailureArtifact,
  type IsolateWorktree,
  type QueueRunner,
  type QueueRunJudgment,
  type QueueRunResult,
} from "./queue-runner.ts";
import {
  DEFAULT_QUEUE_ISOLATION,
  DEFAULT_QUEUE_MAX_ATTEMPTS,
  evaluateQueueDependencies,
  isDependencyWaitReason,
  shouldResumeQueueSession,
  type QueueAttemptRecord,
  type QueueDependencyGate,
  type QueueSessionMode,
  type QueueStore,
  type QueueTask,
  type QueueTaskStatus,
} from "./queue-store.ts";

export type QueueAbortReason = "outside_window" | "daemon_stop" | "cancel";

export type QueueEvent =
  | { type: "queue:job-started"; id: string }
  | { type: "queue:job-finished"; id: string; status: QueueTaskStatus }
  | { type: "promotion:entered" }
  | { type: "promotion:exited" };

type JobHandle = {
  abort: AbortController;
  reason?: QueueAbortReason;
  done: Promise<void>;
};

const OUTPUT_LIMIT = 8000;
export const DEFAULT_QUEUE_RETRY_DELAY_MS = 250;

export type QueueSleep = (ms: number) => Promise<void>;

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class QueueManager {
  private readonly store: QueueStore;
  private readonly schedule: () => PromotionSchedule;
  private readonly now: () => number;
  private readonly runner: QueueRunner;
  private readonly isolateWorktree: IsolateWorktree;
  private readonly emit: (event: QueueEvent) => void;
  private readonly retryDelayMs: number;
  private readonly sleep: QueueSleep;
  private readonly jobs = new Map<string, JobHandle>();
  private shuttingDown = false;

  constructor(opts: {
    store: QueueStore;
    schedule: () => PromotionSchedule;
    now: () => number;
    runner: QueueRunner;
    emit: (event: QueueEvent) => void;
    isolateWorktree?: IsolateWorktree;
    retryDelayMs?: number;
    sleep?: QueueSleep;
  }) {
    this.store = opts.store;
    this.schedule = opts.schedule;
    this.now = opts.now;
    this.runner = opts.runner;
    this.isolateWorktree = opts.isolateWorktree ?? addIsolatedWorktree;
    this.emit = opts.emit;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_QUEUE_RETRY_DELAY_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  runningCount(): number {
    return this.jobs.size;
  }

  markStaleRunning(): QueueTask[] {
    const interrupted = this.store.markStaleRunning(this.now());
    for (const task of interrupted) {
      this.emit({ type: "queue:job-finished", id: task.id, status: "interrupted" });
    }
    return interrupted;
  }

  async reconcile(): Promise<void> {
    if (this.shuttingDown) return;
    const inWindow = isInPromotionWindow(this.now(), this.schedule());
    if (!inWindow) {
      await this.interruptAll("outside_window");
      return;
    }
    this.fillSlots();
  }

  async cancel(id: string): Promise<QueueTask> {
    const task = this.store.resolve(id);
    if (task.status === "queued") {
      const cancelled = this.store.update(task.id, {
        status: "cancelled",
        finishedAt: new Date(this.now()).toISOString(),
        error: "cancelled",
        reason: "cancelled",
      });
      this.refreshDependencyReasons();
      return cancelled;
    }
    if (task.status === "running") {
      await this.abortJob(task.id, "cancel");
      this.refreshDependencyReasons();
      const latest = this.store.get(task.id);
      if (!latest) throw new Error(`unknown queue task ${id}`);
      return latest;
    }
    throw new Error(`cannot cancel ${task.id} (${task.status})`);
  }

  async retry(id: string): Promise<QueueTask> {
    const resolved = this.store.resolve(id);
    const rearmed = this.store.rearm(resolved.id);
    await this.reconcile();
    return this.store.get(resolved.id) ?? rearmed;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.interruptAll("daemon_stop");
  }

  resetLifecycle(): void {
    this.shuttingDown = false;
  }

  private refreshDependencyReasons(): void {
    const snapshot = this.store.list();
    for (const task of snapshot) {
      if (task.status !== "queued") continue;
      this.recordDependencyState(task, evaluateQueueDependencies(task, snapshot));
    }
  }

  private fillSlots(): void {
    if (this.shuttingDown) return;
    const cap = this.schedule().maxConcurrency;
    const snapshot = this.store.list();
    const queued = snapshot
      .filter((task) => task.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const task of queued) {
      if (this.jobs.size >= cap) break;
      if (!isInPromotionWindow(this.now(), this.schedule())) return;
      if (this.jobs.has(task.id)) continue;
      const gate = evaluateQueueDependencies(task, snapshot);
      this.recordDependencyState(task, gate);
      if (!gate.ready) continue;
      if (!this.launch(task)) break;
    }
  }

  private recordDependencyState(task: QueueTask, gate: QueueDependencyGate): void {
    if (task.status !== "queued") return;
    if (gate.ready) {
      if (isDependencyWaitReason(task.reason)) {
        this.store.update(task.id, { reason: undefined, error: undefined });
      }
      return;
    }
    if (task.reason === gate.reason) return;
    this.store.update(task.id, {
      reason: gate.reason,
      error: gate.reason,
    });
  }

  private launch(task: QueueTask): boolean {
    if (this.shuttingDown || !isInPromotionWindow(this.now(), this.schedule())) return false;
    const abort = new AbortController();
    const handle: JobHandle = { abort, done: Promise.resolve() };
    this.jobs.set(task.id, handle);
    const nextAttempt = (task.attempts ?? 0) + 1;
    const baseDir = task.artifactDir ?? this.store.artifactDir(task.id);
    this.store.update(task.id, {
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
      attempts: nextAttempt,
      artifactDir: baseDir,
      ...(isDependencyWaitReason(task.reason) ? { reason: undefined, error: undefined } : {}),
    });
    this.emit({ type: "queue:job-started", id: task.id });
    handle.done = this.run(task.id, handle).finally(() => {
      this.jobs.delete(task.id);
      if (!this.shuttingDown && isInPromotionWindow(this.now(), this.schedule())) {
        this.fillSlots();
      }
    });
    return true;
  }

  private async run(id: string, handle: JobHandle): Promise<void> {
    const task = this.store.get(id);
    if (!task) return;
    const baseDir = task.artifactDir ?? this.store.artifactDir(id);
    const attemptNo = task.attempts > 0 ? task.attempts : 1;
    const attemptDir = this.store.attemptArtifactDir(id, attemptNo);
    const finishAbort = (status: QueueTaskStatus, extra?: { output?: string; error?: string }) => {
      this.store.update(id, {
        status,
        finishedAt: new Date(this.now()).toISOString(),
        ...(extra?.output != null ? { output: extra.output } : {}),
        ...(extra?.error != null ? { error: extra.error, reason: extra.error } : {}),
      });
      this.emit({ type: "queue:job-finished", id, status });
    };
    // A failed setup (repo check, worktree creation) never reached the worker, so it used no
    // attempt. Record it as an attempt so the retry budget still governs, and re-queue while
    // budget remains instead of ending the task as terminal on a transient error.
    const finishSetupFailure = (message: string) => {
      if (handle.reason) {
        finishAbort(statusForAbort(handle.reason), { error: handle.reason });
        return;
      }
      writeSetupFailureArtifact(attemptDir, message);
      const outcome = this.recordAttempt(
        id,
        attemptDir,
        { code: 1, signal: null, stdout: "", stderr: message },
        task.startedAt,
        { verdict: "failed", reason: setupFailureMessage(message), cause: "setup_failed" },
        "fresh",
      );
      if (outcome.canRetry) void this.sleep(this.retryDelayMs);
    };

    try {
      if (this.shouldStop(handle)) {
        const reason = handle.reason ?? abortReasonNow(handle, this.now, this.schedule);
        finishAbort(statusForAbort(reason), { error: reason });
        return;
      }
      const isolation = task.isolation ?? DEFAULT_QUEUE_ISOLATION;
      const repo =
        isolation === "none" ? inspectRepositoryPath(task.repository) : inspectRepository(task.repository);
      if (!repo.ok) {
        finishSetupFailure(repo.error);
        return;
      }
      if (this.shouldStop(handle)) {
        const reason = handle.reason ?? abortReasonNow(handle, this.now, this.schedule);
        finishAbort(statusForAbort(reason), { error: reason });
        return;
      }
      let cwd = resolve(task.repository);
      if (isolation === "worktree") {
        const worktreeDir = task.worktreeDir ?? join(baseDir, "work");
        if (!task.worktreeDir || !existsSync(worktreeDir)) {
          const isolated = this.isolateWorktree({ repository: resolve(task.repository), worktreeDir });
          if (!isolated.ok) {
            finishSetupFailure(isolated.error);
            return;
          }
        }
        if (this.shouldStop(handle)) {
          const reason = handle.reason ?? abortReasonNow(handle, this.now, this.schedule);
          finishAbort(statusForAbort(reason), { error: reason });
          return;
        }
        this.store.update(id, { worktreeDir, artifactDir: baseDir });
        cwd = worktreeDir;
      }
      if (this.shouldStop(handle)) {
        const reason = handle.reason ?? abortReasonNow(handle, this.now, this.schedule);
        finishAbort(statusForAbort(reason), { error: reason });
        return;
      }
      const latest = this.store.get(id) ?? task;
      const previous = latest.attemptHistory.at(-1);
      const continuation = latest.attemptHistory.length > 0;
      const resume = continuation && shouldResumeQueueSession(previous);
      const sessionMode: QueueSessionMode = resume ? "resume" : "fresh";
      const sessionId = resume ? (previous?.sessionId ?? latest.sessionIds.at(-1)) : undefined;
      const schedule = this.schedule();
      const result = await this.runner(
        {
          id,
          prompt: latest.prompt,
          cwd,
          modelSelector: promotionalModelSelector(schedule),
          artifactDir: attemptDir,
          sessionId,
          continuation,
          continuationKind: continuation ? sessionMode : undefined,
          priorReason: latest.reason,
        },
        handle.abort.signal,
      );
      if (handle.reason) {
        finishAbort(statusForAbort(handle.reason), {
          output: clipOutput(result.stdout, result.stderr),
          error: handle.reason,
        });
        return;
      }
      const recorded = this.recordAttempt(id, attemptDir, result, latest.startedAt, undefined, sessionMode);
      if (recorded.canRetry && !this.shouldStop(handle)) {
        await this.sleep(this.retryDelayMs);
      }
    } catch (error) {
      if (handle.reason) {
        finishAbort(statusForAbort(handle.reason), {
          error: handle.reason,
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const recorded = this.recordAttempt(
        id,
        attemptDir,
        { code: 1, signal: null, stdout: "", stderr: message },
        task.startedAt,
        { verdict: "failed", reason: message, cause: "exit" },
        "fresh",
      );
      if (recorded.canRetry && !this.shouldStop(handle)) {
        await this.sleep(this.retryDelayMs);
      }
    }
  }

  private recordAttempt(
    id: string,
    attemptDir: string,
    result: QueueRunResult,
    startedAt: string | undefined,
    override?: QueueRunJudgment,
    sessionMode: QueueSessionMode = "fresh",
  ): { canRetry: boolean } {
    const task = this.store.get(id);
    if (!task) return { canRetry: false };
    const judged = override ?? judgeQueueRun(result);
    const sessionId = judged.sessionId;
    const sessionIds = sessionId ? [...task.sessionIds, sessionId] : [...task.sessionIds];
    const finishedAt = new Date(this.now()).toISOString();
    const record: QueueAttemptRecord = {
      attempt: task.attempts,
      ...(sessionId ? { sessionId } : {}),
      sessionMode,
      cause: judged.cause,
      verdict: judged.verdict,
      reason: judged.reason,
      artifactDir: attemptDir,
      startedAt: startedAt ?? finishedAt,
      finishedAt,
    };
    const attemptHistory = [...task.attemptHistory, record];
    const maxAttempts = task.maxAttempts ?? DEFAULT_QUEUE_MAX_ATTEMPTS;
    const retryable = judged.verdict === "incomplete" || judged.verdict === "failed";
    const canRetry = retryable && task.attempts < maxAttempts;
    const brakeCount = attemptHistory.filter((item) => item.cause === "brake_paused").length;
    const reason =
      !canRetry && judged.cause === "brake_paused" && brakeCount >= 2
        ? OAR_BRAKE_EXHAUSTED_REASON
        : judged.reason;
    if (reason !== record.reason) {
      record.reason = reason;
    }
    const status: QueueTaskStatus = judged.verdict === "completed" ? "completed" : canRetry ? "queued" : judged.verdict;
    this.store.update(id, {
      status,
      verdict: judged.verdict,
      reason,
      sessionIds,
      attemptHistory,
      artifactDir: task.artifactDir ?? this.store.artifactDir(id),
      output: clipOutput(result.stdout, result.stderr),
      error: judged.verdict === "completed" ? undefined : reason,
      finishedAt,
    });
    this.emit({ type: "queue:job-finished", id, status: canRetry ? judged.verdict : status });
    return { canRetry };
  }

  private shouldStop(handle: JobHandle): boolean {
    if (handle.abort.signal.aborted || this.shuttingDown) return true;
    if (!isInPromotionWindow(this.now(), this.schedule())) {
      handle.reason = handle.reason ?? "outside_window";
      if (!handle.abort.signal.aborted) handle.abort.abort();
      return true;
    }
    return false;
  }

  private async interruptAll(reason: QueueAbortReason): Promise<void> {
    const ids = [...this.jobs.keys()];
    await Promise.all(ids.map((id) => this.abortJob(id, reason)));
  }

  private async abortJob(id: string, reason: QueueAbortReason): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.reason = reason;
    if (!job.abort.signal.aborted) job.abort.abort();
    await job.done;
  }
}

function abortReasonNow(
  handle: JobHandle,
  now: () => number,
  schedule: () => PromotionSchedule,
): QueueAbortReason {
  if (handle.reason) return handle.reason;
  if (!isInPromotionWindow(now(), schedule())) return "outside_window";
  return "daemon_stop";
}

function statusForAbort(reason: QueueAbortReason): QueueTaskStatus {
  return reason === "cancel" ? "cancelled" : "interrupted";
}

function clipOutput(stdout: string, stderr: string): string {
  const text = [stdout, stderr].filter((part) => part.length > 0).join("\n");
  if (text.length <= OUTPUT_LIMIT) return text;
  return text.slice(0, OUTPUT_LIMIT);
}

