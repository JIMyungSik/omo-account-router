import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OarClient } from "../src/client.ts";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";
import {
  addIsolatedWorktree,
  buildOmoArgv,
  composeQueuePrompt,
  judgeQueueRun,
  OAR_BRAKE_EXHAUSTED_REASON,
  OAR_BRAKE_MARKER,
  OAR_RESULT_DONE,
  QUEUE_COMPLETION_CONTRACT,
  QUEUE_CONTINUATION_PREAMBLE,
  QUEUE_FRESH_CONTINUATION_PREAMBLE,
  type QueueRunner,
} from "../src/queue-runner.ts";
import { QueueManager, type QueueEvent } from "../src/queue-manager.ts";
import {
  QueueStore,
  resolveDependsOn,
  type QueueTask,
  type QueueTaskView,
} from "../src/queue-store.ts";
import { DEFAULT_PROMOTION_SCHEDULE, type PromotionSchedule } from "../src/promotion.ts";

const FAKE_OMO = fileURLToPath(new URL("./fixtures/fake-omo.mjs", import.meta.url));
const OMO_DUMP = fileURLToPath(new URL("./fixtures/omo-prompt-dump.mjs", import.meta.url));
const KST_MIDNIGHT = Date.parse("2026-10-02T15:00:00.000Z");
const KST_TEN = Date.parse("2026-10-03T01:00:00.000Z");
const OMO_BIN = process.env.OMO_BIN || Bun.which("omo");
const ENABLED_SCHEDULE: PromotionSchedule = {
  ...DEFAULT_PROMOTION_SCHEDULE,
  enabled: true,
};

function waitEvents(
  daemon: OarDaemon,
  predicate: (event: QueueEvent) => boolean,
  count: number,
  timeoutMs = 4000,
): Promise<QueueEvent[]> {
  return new Promise((resolve, reject) => {
    const got: QueueEvent[] = [];
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for ${count} events, got ${got.length}`));
    }, timeoutMs);
    const off = daemon.onQueueEvent((event) => {
      if (!predicate(event)) return;
      got.push(event);
      if (got.length >= count) {
        clearTimeout(timer);
        off();
        resolve(got);
      }
    });
  });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || args.join(" "));
    }
  };
  run(["init"]);
  run(["config", "user.email", "queue@test"]);
  run(["config", "user.name", "Queue Test"]);
  writeFileSync(join(dir, "README"), "source\n");
  run(["add", "."]);
  run(["commit", "-m", "init"]);
}

/** Poll the store until a task reaches a terminal status, so tests never rely on a fixed sleep. */
async function waitForStatus(
  store: QueueStore,
  id: string,
  status: QueueTask["status"],
  timeoutMs = 4000,
): Promise<QueueTask> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = store.get(id);
    if (task?.status === status) return task;
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for ${id} to reach ${status}, saw ${task?.status ?? "missing"} (${task?.reason ?? ""})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForFile(path: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled || !existsSync(path)) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      resolve(readFileSync(path, "utf8"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      watcher.close();
      reject(new Error(`timeout waiting for ${path}`));
    }, timeoutMs);
    const watcher = watch(dirname(path), (_event, filename) => {
      if (!filename || filename === basename(path) || filename === `${basename(path)}`) finish();
    });
    finish();
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM delivery to a process group is asynchronous, so a worker's children can outlive the
 * child-close event by a few milliseconds. Wait for the exit with a bound instead of asserting
 * that death has already happened.
 */
async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() > deadline) {
      throw new Error(`process ${pid} was still alive after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function asTasks(data: unknown): QueueTask[] {
  if (!Array.isArray(data)) throw new Error("expected task list");
  return data as QueueTask[];
}

function assistantStdout(text: string, extra: Record<string, unknown> = {}, sessionId = "sess-1"): string {
  return [
    JSON.stringify({ type: "session", id: sessionId }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], ...extra },
    }),
  ].join("\n");
}

function expectUserPromptPreserved(composed: string, userPrompt: string): void {
  expect(composed.includes(userPrompt)).toBe(true);
  expect(composed).toContain(OAR_RESULT_DONE);
  expect(composed).toContain(QUEUE_COMPLETION_CONTRACT);
}

describe("queue daemon integration", () => {
  let root: string;
  let sock: string;
  let repo: string;
  let control: string;
  let now: number;
  let daemon: OarDaemon;
  let client: OarClient;
  const previousFakeMode = process.env.OAR_FAKE_OMO_MODE;
  const previousFakeControl = process.env.OAR_FAKE_OMO_CONTROL;

  async function startDaemon(): Promise<void> {
    daemon = new OarDaemon({
      store: new OarStore({ rootDir: root }),
      socketPath: sock,
      activateOnUse: false,
      now: () => now,
      omoCommand: { bin: process.execPath, prefixArgs: [FAKE_OMO] },
      queueRetryDelayMs: 0,
      queueSleep: async () => {},
    });
    await daemon.start();
    client = new OarClient({ socketPath: sock, retries: 8, timeoutMs: 2000 });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-queue-"));
    sock = join(root, "oar.sock");
    repo = join(root, "repo");
    control = join(root, "control");
    mkdirSync(control, { recursive: true });
    initRepo(repo);
    now = KST_MIDNIGHT;
    process.env.OAR_FAKE_OMO_CONTROL = control;
    process.env.OAR_FAKE_OMO_MODE = "hang";
    await startDaemon();
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    if (previousFakeMode === undefined) delete process.env.OAR_FAKE_OMO_MODE;
    else process.env.OAR_FAKE_OMO_MODE = previousFakeMode;
    if (previousFakeControl === undefined) delete process.env.OAR_FAKE_OMO_CONTROL;
    else process.env.OAR_FAKE_OMO_CONTROL = previousFakeControl;
    rmSync(root, { recursive: true, force: true });
  });

  async function enableSchedule(maxConcurrency = 3): Promise<void> {
    const res = await client.request({
      protocol: 1,
      action: "schedule-configure",
      maxConcurrency,
    });
    expect(res.ok).toBe(true);
  }

  async function addJob(
    prompt: string,
    extra?: { maxAttempts?: number; isolation?: QueueTask["isolation"]; dependsOn?: string[] },
  ): Promise<QueueTask> {
    const res = await client.request({
      protocol: 1,
      action: "queue-add",
      prompt,
      repository: repo,
      ...(extra?.maxAttempts != null ? { maxAttempts: extra.maxAttempts } : {}),
      ...(extra?.isolation ? { isolation: extra.isolation } : {}),
      ...(extra?.dependsOn ? { dependsOn: extra.dependsOn } : {}),
    });
    expect(res.ok).toBe(true);
    return res.data as QueueTask;
  }

  test("buildOmoArgv uses print mode and does not put the prompt on argv", () => {
    const args = buildOmoArgv({
      modelSelector: "opengateway/deepseek/deepseek-v4.1-flash-ultrafast",
    });
    expect(args.at(-1)).toBe("-p");
    expect(args).not.toContain("-evil @/tmp/x --help");
    expect(args).toContain("--no-model-fallback");
    expect(args).toContain("--no-ask-user");
  });

  test("caps concurrent workers and preserves isolation on completion", async () => {
    const firstThree = waitEvents(daemon, (event) => event.type === "queue:job-started", 3);
    await enableSchedule(3);
    const prompts = ["one", "two", "three", "four", "five"];
    const jobs: QueueTask[] = [];
    for (const prompt of prompts) jobs.push(await addJob(prompt));
    const started = await firstThree;
    expect(started).toHaveLength(3);

    const listed = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data);
    expect(listed.filter((task) => task.status === "running")).toHaveLength(3);
    expect(listed.filter((task) => task.status === "queued")).toHaveLength(2);

    const fourthStart = waitEvents(daemon, (event) => event.type === "queue:job-started", 1);
    const firstDone = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.id === started[0]!.id,
      1,
    );
    writeFileSync(join(control, `${started[0]!.id}.release`), "1");
    await firstDone;
    const [fourth] = await fourthStart;
    const after = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data);
    expect(after.filter((task) => task.status === "running")).toHaveLength(3);
    expect(after.filter((task) => task.status === "completed")).toHaveLength(1);
    expect(after.filter((task) => task.status === "queued")).toHaveLength(1);
    expect(fourth.id).not.toBe(started[0]!.id);

    const completed = after.find((task) => task.status === "completed");
    expect(completed?.worktreeDir).toBeTruthy();
    expect(completed?.worktreeDir).not.toBe(repo);
    const argv = JSON.parse(readFileSync(join(completed!.worktreeDir!, "argv.json"), "utf8")) as string[];
    const shipped = jobs.find((job) => job.id === completed?.id)?.prompt ?? "";
    expect(argv.includes("-p")).toBe(true);
    expect(argv).not.toContain(shipped);
    const stdin = readFileSync(join(completed!.worktreeDir!, "stdin.txt"), "utf8");
    expectUserPromptPreserved(stdin, shipped);
    const attemptPrompt = readFileSync(
      join(completed!.artifactDir!, "attempt-1", "user-prompt.txt"),
      "utf8",
    );
    expect(attemptPrompt).toBe(shipped);
    expect(spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).stdout).toBe("");
  });

  test("records completion when the DONE sentinel is present", async () => {
    process.env.OAR_FAKE_OMO_MODE = "complete";
    const done = waitEvents(daemon, (event) => event.type === "queue:job-finished", 1);
    await enableSchedule();
    const ok = await addJob("plain prompt");
    const [finished] = await done;
    expect(finished).toEqual({ type: "queue:job-finished", id: ok.id, status: "completed" });
    const listed = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data);
    expect(listed[0]?.status).toBe("completed");
    expect(listed[0]?.verdict).toBe("completed");
    expect(listed[0]?.attempts).toBe(1);
  });

  test("restart interrupts running jobs and does not rerun them", async () => {
    const started = waitEvents(daemon, (event) => event.type === "queue:job-started", 1);
    await enableSchedule();
    const job = await addJob("hang across restart");
    await started;
    await daemon.stop();

    const persisted = asTasks(
      (await (async () => {
        now = KST_MIDNIGHT;
        await startDaemon();
        return client.request({ protocol: 1, action: "queue-list" });
      })()).data,
    );
    const same = persisted.find((task) => task.id === job.id);
    expect(same?.status).toBe("interrupted");
    expect(persisted.filter((task) => task.status === "running")).toHaveLength(0);
  });

  test("cancel stops queued and running jobs", async () => {
    now = KST_TEN;
    await enableSchedule();
    const queued = await addJob("stay queued");
    const cancelled = await client.request({ protocol: 1, action: "queue-cancel", id: queued.id });
    expect(cancelled.ok).toBe(true);
    expect((cancelled.data as QueueTask).status).toBe("cancelled");

    now = KST_MIDNIGHT;
    await daemon.reconcilePromotion();
    const runningWait = waitEvents(daemon, (event) => event.type === "queue:job-started", 1);
    const running = await addJob("cancel while running");
    await runningWait;
    const finished = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.id === running.id,
      1,
    );
    const cancelRunning = await client.request({ protocol: 1, action: "queue-cancel", id: running.id });
    expect(cancelRunning.ok).toBe(true);
    const [done] = await finished;
    expect(done.status).toBe("cancelled");
    expect((cancelRunning.data as QueueTask).status).toBe("cancelled");
  });

  test("refuses to launch outside the window and interrupts at 10:00", async () => {
    now = KST_TEN;
    await enableSchedule();
    const job = await addJob("after ten");
    const listed = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data);
    expect(listed).toEqual([expect.objectContaining({ id: job.id, status: "queued" })]);

    now = KST_MIDNIGHT;
    const started = waitEvents(daemon, (event) => event.type === "queue:job-started", 1);
    await daemon.reconcilePromotion();
    await started;

    const interrupted = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.id === job.id,
      1,
    );
    now = KST_TEN;
    await daemon.reconcilePromotion();
    const [done] = await interrupted;
    expect(done.status).toBe("interrupted");
    const after = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data);
    expect(after[0]?.status).toBe("interrupted");
  });

  test("unsuitable repositories fail the task and keep the source tree untouched", async () => {
    process.env.OAR_FAKE_OMO_MODE = "complete";
    const bare = join(root, "not-git");
    mkdirSync(bare);
    // A permanently unsuitable repository burns every attempt before it is terminal, so
    // wait for the terminal event rather than the first job-finished event.
    const finished = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.status === "failed",
      1,
    );
    await enableSchedule();
    const res = await client.request({
      protocol: 1,
      action: "queue-add",
      prompt: "should fail isolation",
      repository: bare,
      maxAttempts: 1,
    });
    expect(res.ok).toBe(true);
    const [done] = await finished;
    expect(done.status).toBe("failed");
    const task = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data)[0];
    expect(task?.isolation).toBe("worktree");
    expect(task?.attempts).toBe(1);
    expect(task?.attemptHistory[0]?.cause).toBe("setup_failed");
    expect(task?.error).toMatch(/not a git/i);
    expect(task?.error).toMatch(/--isolate none/);
    expect(task?.worktreeDir).toBeUndefined();
  });

  test("isolation none runs a non-git directory in place", async () => {
    process.env.OAR_FAKE_OMO_MODE = "complete";
    const bare = join(root, "plain-dir");
    mkdirSync(bare);
    writeFileSync(join(bare, "keep.txt"), "untouched\n");
    const finished = waitEvents(daemon, (event) => event.type === "queue:job-finished", 1);
    await enableSchedule();
    const res = await client.request({
      protocol: 1,
      action: "queue-add",
      prompt: "run in place",
      repository: bare,
      isolation: "none",
    });
    expect(res.ok).toBe(true);
    expect((res.data as QueueTask).isolation).toBe("none");
    const [done] = await finished;
    expect(done.status).toBe("completed");
    const task = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data)[0];
    expect(task?.isolation).toBe("none");
    expect(task?.status).toBe("completed");
    expect(task?.worktreeDir).toBeUndefined();
    expectUserPromptPreserved(readFileSync(join(bare, "stdin.txt"), "utf8"), "run in place");
    expect(JSON.parse(readFileSync(join(bare, "argv.json"), "utf8"))).toContain("-p");
    expect(readFileSync(join(bare, "keep.txt"), "utf8")).toBe("untouched\n");
    expect(existsSync(join(bare, "work"))).toBe(false);
  });

  test("isolation none refuses a missing or non-directory path", async () => {
    process.env.OAR_FAKE_OMO_MODE = "complete";
    await enableSchedule();
    const missing = join(root, "does-not-exist");
    const missingDone = waitEvents(daemon, (event) => event.type === "queue:job-finished", 1);
    const missingAdd = await client.request({
      protocol: 1,
      action: "queue-add",
      prompt: "missing path",
      repository: missing,
      isolation: "none",
    });
    expect(missingAdd.ok).toBe(true);
    expect((await missingDone)[0]?.status).toBe("failed");
    const listed = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data);
    expect(listed[0]?.error).toMatch(/not found/i);
    expect(listed[0]?.worktreeDir).toBeUndefined();

    const filePath = join(root, "not-a-dir.txt");
    writeFileSync(filePath, "x\n");
    const fileDone = waitEvents(daemon, (event) => event.type === "queue:job-finished", 1);
    const fileAdd = await client.request({
      protocol: 1,
      action: "queue-add",
      prompt: "file path",
      repository: filePath,
      isolation: "none",
    });
    expect(fileAdd.ok).toBe(true);
    expect((await fileDone)[0]?.status).toBe("failed");
    const after = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data);
    const fileTask = after.find((task) => task.prompt === "file path");
    expect(fileTask?.error).toMatch(/not a directory/i);
    expect(fileTask?.worktreeDir).toBeUndefined();
  });

  test("persists isolation strategy across store reload", () => {
    const dir = join(root, "store-roundtrip");
    const store = new QueueStore({ rootDir: dir });
    const none = store.add({ prompt: "plain", repository: repo, isolation: "none", nowMs: now });
    const def = store.add({ prompt: "git default", repository: repo, nowMs: now });
    expect(none.isolation).toBe("none");
    expect(def.isolation).toBe("worktree");
    const reloaded = new QueueStore({ rootDir: dir });
    expect(reloaded.get(none.id)?.isolation).toBe("none");
    expect(reloaded.get(def.id)?.isolation).toBe("worktree");
    expect(reloaded.list().map((task) => task.isolation).sort()).toEqual(["none", "worktree"]);
  });

  test("marks stale running jobs interrupted on daemon start without implicit retry", async () => {
    await daemon.stop();
    writeFileSync(
      join(root, "queue.json"),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        tasks: [
          {
            id: "stale-1",
            prompt: "partial edit",
            repository: repo,
            status: "running",
            createdAt: new Date(KST_MIDNIGHT).toISOString(),
            startedAt: new Date(KST_MIDNIGHT).toISOString(),
          },
        ],
      }),
      "utf8",
    );
    now = KST_MIDNIGHT;
    await startDaemon();
    await enableSchedule();
    const listed = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data);
    expect(listed).toEqual([
      expect.objectContaining({ id: "stale-1", status: "interrupted", prompt: "partial edit" }),
    ]);
  });

  test("cancel terminates the worker process tree", async () => {
    const started = waitEvents(daemon, (event) => event.type === "queue:job-started", 1);
    await enableSchedule();
    const job = await addJob("kill the tree");
    await started;
    const childPid = Number((await waitForFile(join(control, `${job.id}.child-pid`))).trim());
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(processAlive(childPid)).toBe(true);

    const finished = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.id === job.id,
      1,
    );
    const cancelled = await client.request({ protocol: 1, action: "queue-cancel", id: job.id });
    expect(cancelled.ok).toBe(true);
    const [done] = await finished;
    expect(done.status).toBe("cancelled");
    await expect(waitForProcessExit(childPid)).resolves.toBeUndefined();
  });

  test("does not dispatch after the window ends during worktree setup", async () => {
    let nowMs = KST_MIDNIGHT;
    let runnerCalled = false;
    const store = new QueueStore({ rootDir: join(root, "setup-clock") });
    let finishedResolve: (event: QueueEvent) => void = () => {};
    const finishedEvent = new Promise<QueueEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for interrupted job")), 4000);
      finishedResolve = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
    });
    const manager = new QueueManager({
      store,
      schedule: () => ENABLED_SCHEDULE,
      now: () => nowMs,
      retryDelayMs: 0,
      sleep: async () => {},
      isolateWorktree: (opts) => {
        nowMs = KST_TEN;
        return addIsolatedWorktree(opts);
      },
      runner: async () => {
        runnerCalled = true;
        return { code: 0, signal: null, stdout: "", stderr: "" };
      },
      emit: (event) => {
        if (event.type === "queue:job-finished") finishedResolve(event);
      },
    });
    const task = store.add({ prompt: "cross the boundary", repository: repo, nowMs });
    await manager.reconcile();
    const done = await finishedEvent;
    expect(done).toEqual({ type: "queue:job-finished", id: task.id, status: "interrupted" });
    expect(runnerCalled).toBe(false);
    expect(store.get(task.id)?.status).toBe("interrupted");
    expect(store.get(task.id)?.error).toBe("outside_window");
  });

  test("DONE sentinel completes a job", async () => {
    process.env.OAR_FAKE_OMO_MODE = "complete";
    const done = waitEvents(daemon, (event) => event.type === "queue:job-finished", 1);
    await enableSchedule();
    const job = await addJob("finish with sentinel");
    const [finished] = await done;
    expect(finished).toEqual({ type: "queue:job-finished", id: job.id, status: "completed" });
    const task = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data)[0];
    expect(task?.status).toBe("completed");
    expect(task?.verdict).toBe("completed");
    expect(task?.attempts).toBe(1);
    expect(task?.maxAttempts).toBe(3);
    expect(task?.sessionIds).toEqual([`fake-${job.id}`]);
  });

  test("INCOMPLETE sentinel is retried then becomes terminal incomplete", async () => {
    process.env.OAR_FAKE_OMO_MODE = "incomplete";
    const started = waitEvents(daemon, (event) => event.type === "queue:job-started", 2);
    const finished = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.status === "incomplete",
      2,
    );
    await enableSchedule();
    const job = await addJob("recon only", { maxAttempts: 2 });
    await started;
    const ends = await finished;
    expect(ends.map((event) => event.status)).toEqual(["incomplete", "incomplete"]);
    const task = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data).find(
      (item) => item.id === job.id,
    );
    expect(task?.status).toBe("incomplete");
    expect(task?.verdict).toBe("incomplete");
    expect(task?.reason).toBe("reconnaissance only");
    expect(task?.attempts).toBe(2);
    expect(task?.maxAttempts).toBe(2);
    expect(task?.attemptHistory).toHaveLength(2);
    expect(task?.attemptHistory.map((item) => item.sessionMode)).toEqual(["fresh", "resume"]);
    expect(task?.attemptHistory.map((item) => item.sessionId)).toEqual([`fake-${job.id}`, `fake-${job.id}`]);
    expect(task?.attemptHistory.map((item) => item.cause)).toEqual([
      "incomplete_sentinel",
      "incomplete_sentinel",
    ]);
  });

  test("exit 0 with no sentinel is never completed", async () => {
    process.env.OAR_FAKE_OMO_MODE = "no-sentinel";
    const finished = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.status === "incomplete",
      2,
    );
    await enableSchedule();
    const job = await addJob("idle exit", { maxAttempts: 2 });
    await finished;
    const task = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data).find(
      (item) => item.id === job.id,
    );
    expect(task?.status).toBe("incomplete");
    expect(task?.verdict).toBe("incomplete");
    expect(task?.reason).toBe("missing_sentinel");
    expect(task?.attempts).toBe(2);
    expect(asTasks((await client.request({ protocol: 1, action: "queue-list" })).data).some((item) => item.status === "completed")).toBe(false);
  });

  test("non-zero exit is failed then retried", async () => {
    process.env.OAR_FAKE_OMO_MODE = "fail";
    const started = waitEvents(daemon, (event) => event.type === "queue:job-started", 2);
    const finished = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.status === "failed",
      2,
    );
    await enableSchedule();
    const job = await addJob("boom", { maxAttempts: 2 });
    await started;
    await finished;
    const task = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data).find(
      (item) => item.id === job.id,
    );
    expect(task?.status).toBe("failed");
    expect(task?.verdict).toBe("failed");
    expect(task?.reason).toBe("exit:2");
    expect(task?.attempts).toBe(2);
  });

  test("brake-paused stdout is recorded as its own cause", async () => {
    process.env.OAR_FAKE_OMO_MODE = "brake";
    const finished = waitEvents(daemon, (event) => event.type === "queue:job-finished", 1);
    await enableSchedule();
    const job = await addJob("brake me", { maxAttempts: 1 });
    const [done] = await finished;
    expect(done.status).toBe("incomplete");
    const task = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data).find(
      (item) => item.id === job.id,
    );
    expect(task?.status).toBe("incomplete");
    expect(task?.reason).toBe(OAR_BRAKE_MARKER);
    expect(task?.verdict).toBe("incomplete");
    expect(task?.attemptHistory[0]?.sessionMode).toBe("fresh");
    expect(task?.attemptHistory[0]?.cause).toBe("brake_paused");
  });

  test("brake-paused retry starts a fresh session and does not resume the paused one", async () => {
    process.env.OAR_FAKE_OMO_MODE = "brake";
    const started = waitEvents(daemon, (event) => event.type === "queue:job-started", 2);
    const finished = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.status === "incomplete",
      2,
    );
    await enableSchedule();
    const job = await addJob("brake then retry", { maxAttempts: 2 });
    await started;
    await finished;
    const task = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data).find(
      (item) => item.id === job.id,
    );
    expect(task?.status).toBe("incomplete");
    expect(task?.reason).toBe(OAR_BRAKE_EXHAUSTED_REASON);
    expect(task?.attempts).toBe(2);
    const firstSession = `fake-${job.id}`;
    const secondSession = `fake-${job.id}-2`;
    expect(task?.sessionIds).toEqual([firstSession, secondSession]);
    expect(task?.attemptHistory.map((item) => item.sessionMode)).toEqual(["fresh", "fresh"]);
    expect(task?.attemptHistory.map((item) => item.sessionId)).toEqual([firstSession, secondSession]);
    expect(task?.attemptHistory.map((item) => item.cause)).toEqual(["brake_paused", "brake_paused"]);
    const firstArgv = JSON.parse(
      readFileSync(join(task!.artifactDir!, "attempt-1", "argv.json"), "utf8"),
    ) as string[];
    const secondArgv = JSON.parse(
      readFileSync(join(task!.artifactDir!, "attempt-2", "argv.json"), "utf8"),
    ) as string[];
    expect(firstArgv).not.toContain("--session");
    expect(secondArgv).not.toContain("--session");
    expect(secondArgv).not.toContain(firstSession);
    const secondPrompt = readFileSync(join(task!.artifactDir!, "attempt-2", "prompt.txt"), "utf8");
    expect(secondPrompt).toContain(QUEUE_FRESH_CONTINUATION_PREAMBLE);
    expect(secondPrompt).not.toContain(QUEUE_CONTINUATION_PREAMBLE);
    expect(secondPrompt.includes("brake then retry")).toBe(true);
  });

  test("retry reuses the captured session id", async () => {
    process.env.OAR_FAKE_OMO_MODE = "incomplete";
    const started = waitEvents(daemon, (event) => event.type === "queue:job-started", 2);
    const finished = waitEvents(daemon, (event) => event.type === "queue:job-finished", 2);
    await enableSchedule();
    const job = await addJob("continue me", { maxAttempts: 2 });
    await started;
    await finished;
    const task = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data).find(
      (item) => item.id === job.id,
    );
    const sessionId = `fake-${job.id}`;
    expect(task?.sessionIds).toEqual([sessionId, sessionId]);
    const firstArgv = JSON.parse(
      readFileSync(join(task!.artifactDir!, "attempt-1", "argv.json"), "utf8"),
    ) as string[];
    const secondArgv = JSON.parse(
      readFileSync(join(task!.artifactDir!, "attempt-2", "argv.json"), "utf8"),
    ) as string[];
    expect(firstArgv).not.toContain("--session");
    expect(secondArgv).toContain("--session");
    expect(secondArgv).toContain(sessionId);
    const secondPrompt = readFileSync(join(task!.artifactDir!, "attempt-2", "prompt.txt"), "utf8");
    expect(secondPrompt).toContain(QUEUE_CONTINUATION_PREAMBLE);
    expect(secondPrompt).not.toContain(QUEUE_FRESH_CONTINUATION_PREAMBLE);
    expect(secondPrompt.includes("continue me")).toBe(true);
    expect(task?.attemptHistory.map((item) => item.sessionMode)).toEqual(["fresh", "resume"]);
    expect(task?.attemptHistory.map((item) => item.sessionId)).toEqual([sessionId, sessionId]);
  });

  test("retry is not dispatched outside the window", async () => {
    let nowMs = KST_MIDNIGHT;
    let runnerCalls = 0;
    const store = new QueueStore({ rootDir: join(root, "retry-window") });
    const finishedEvents: QueueEvent[] = [];
    let finishedResolve: (event: QueueEvent) => void = () => {};
    const finishedEvent = new Promise<QueueEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for incomplete attempt")), 4000);
      finishedResolve = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
    });
    const manager = new QueueManager({
      store,
      schedule: () => ENABLED_SCHEDULE,
      now: () => nowMs,
      retryDelayMs: 0,
      sleep: async () => {},
      isolateWorktree: addIsolatedWorktree,
      runner: async () => {
        runnerCalls += 1;
        nowMs = KST_TEN;
        return {
          code: 0,
          signal: null,
          stdout: assistantStdout("OAR_RESULT: INCOMPLETE: stopped at boundary"),
          stderr: "",
        };
      },
      emit: (event) => {
        finishedEvents.push(event);
        if (event.type === "queue:job-finished") finishedResolve(event);
      },
    });
    const task = store.add({ prompt: "hold for morning", repository: repo, maxAttempts: 3, nowMs });
    await manager.reconcile();
    const done = await finishedEvent;
    expect(done).toEqual({ type: "queue:job-finished", id: task.id, status: "incomplete" });
    expect(runnerCalls).toBe(1);
    expect(store.get(task.id)?.status).toBe("queued");
    expect(store.get(task.id)?.attempts).toBe(1);
    expect(store.get(task.id)?.reason).toBe("stopped at boundary");
    await manager.reconcile();
    expect(runnerCalls).toBe(1);
    expect(store.get(task.id)?.status).toBe("queued");
  });

  test("manual retry resets the attempt budget", async () => {
    process.env.OAR_FAKE_OMO_MODE = "incomplete";
    const firstDone = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.status === "incomplete",
      1,
    );
    await enableSchedule();
    const job = await addJob("try again later", { maxAttempts: 1 });
    await firstDone;
    const before = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data).find(
      (item) => item.id === job.id,
    );
    expect(before?.status).toBe("incomplete");
    expect(before?.attempts).toBe(1);

    const secondStart = waitEvents(daemon, (event) => event.type === "queue:job-started", 1);
    const secondDone = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.id === job.id,
      1,
    );
    const retried = await client.request({ protocol: 1, action: "queue-retry", id: job.id });
    expect(retried.ok).toBe(true);
    await secondStart;
    await secondDone;
    const after = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data).find(
      (item) => item.id === job.id,
    );
    expect(after?.status).toBe("incomplete");
    expect(after?.attempts).toBe(1);
    expect(after?.maxAttempts).toBe(1);
    expect(after?.sessionIds.at(-1)).toBe(`fake-${job.id}`);
  });

  test("rejects unknown and self dependencies at add time", async () => {
    const unknown = await client.request({
      protocol: 1,
      action: "queue-add",
      prompt: "blocked by ghost",
      repository: repo,
      dependsOn: ["does-not-exist"],
    });
    expect(unknown.ok).toBe(false);
    expect(String((unknown as { error?: string }).error)).toMatch(/unknown queue task/i);

    const first = await addJob("self-check source");
    expect(() => resolveDependsOn([first.id], [first], first.id)).toThrow(/itself/i);
    const self = await client.request({
      protocol: 1,
      action: "queue-add",
      prompt: "self dep",
      repository: repo,
      dependsOn: [first.id.slice(0, 8), first.id],
    });
    expect(self.ok).toBe(true);
    expect((self.data as QueueTask).dependsOn).toEqual([first.id]);
  });

  test("dependsOn round-trips through the store and list JSON", async () => {
    const dir = join(root, "depends-roundtrip");
    const store = new QueueStore({ rootDir: dir });
    const first = store.add({ prompt: "prereq", repository: repo, nowMs: now });
    const second = store.add({
      prompt: "child",
      repository: repo,
      nowMs: now + 1,
      dependsOn: [first.id.slice(0, 8), first.id, first.id],
    });
    expect(second.dependsOn).toEqual([first.id]);
    const reloaded = new QueueStore({ rootDir: dir });
    expect(reloaded.get(second.id)?.dependsOn).toEqual([first.id]);
  });

  test("skips unmet dependents and gives the slot to the next eligible task", async () => {
    const firstTwo = waitEvents(daemon, (event) => event.type === "queue:job-started", 2);
    await enableSchedule(2);
    const prereq = await addJob("dep-prereq");
    const dependent = await addJob("dep-child", { dependsOn: [prereq.id.slice(0, 8)] });
    const independent = await addJob("dep-free");
    const started = await firstTwo;
    expect(started.map((event) => event.id).sort()).toEqual([prereq.id, independent.id].sort());

    const listed = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data) as QueueTaskView[];
    const blocked = listed.find((task) => task.id === dependent.id);
    expect(blocked?.status).toBe("queued");
    expect(blocked?.dependsOn).toEqual([prereq.id]);
    expect(blocked?.unmetDependsOn).toEqual([prereq.id]);
    expect(blocked?.waiting).toBe(true);
    expect(blocked?.reason).toMatch(/unmet_dependency:/);
    expect(listed.filter((task) => task.status === "running")).toHaveLength(2);

    const childStart = waitEvents(
      daemon,
      (event) => event.type === "queue:job-started" && event.id === dependent.id,
      1,
    );
    const prereqDone = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.id === prereq.id,
      1,
    );
    writeFileSync(join(control, `${prereq.id}.release`), "1");
    await prereqDone;
    await childStart;
    const after = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data) as QueueTaskView[];
    expect(after.find((task) => task.id === dependent.id)?.status).toBe("running");
    expect(after.find((task) => task.id === dependent.id)?.waiting).toBe(false);
  });

  test("cancelled or failed prerequisites leave dependents waiting with a reason", async () => {
    const started = waitEvents(daemon, (event) => event.type === "queue:job-started", 1);
    await enableSchedule(1);
    const prereq = await addJob("cancel-prereq");
    const dependent = await addJob("still-waiting", { dependsOn: [prereq.id] });
    const independent = await addJob("takes-the-slot");
    await started;
    const independentStart = waitEvents(
      daemon,
      (event) => event.type === "queue:job-started" && event.id === independent.id,
      1,
    );
    const cancelled = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.id === prereq.id,
      1,
    );
    await client.request({ protocol: 1, action: "queue-cancel", id: prereq.id.slice(0, 8) });
    await cancelled;
    await independentStart;
    const listed = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data) as QueueTaskView[];
    const blocked = listed.find((task) => task.id === dependent.id);
    expect(blocked?.status).toBe("queued");
    expect(blocked?.waiting).toBe(true);
    expect(blocked?.unmetDependsOn).toEqual([prereq.id]);
    expect(blocked?.reason).toMatch(/unsatisfiable_dependency: .*cancelled/);
    expect(listed.find((task) => task.id === independent.id)?.status).toBe("running");
    expect(listed.some((task) => task.id === dependent.id && task.status === "running")).toBe(false);

    const independentDone = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.id === independent.id,
      1,
    );
    await client.request({ protocol: 1, action: "queue-cancel", id: independent.id });
    await independentDone;

    process.env.OAR_FAKE_OMO_MODE = "fail";
    const failDone = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.status === "failed",
      1,
    );
    const failing = await addJob("fail-prereq", { maxAttempts: 1 });
    const failChild = await addJob("fail-child", { dependsOn: [failing.id] });
    await failDone;
    const afterFail = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data) as QueueTaskView[];
    const failBlocked = afterFail.find((task) => task.id === failChild.id);
    expect(failBlocked?.status).toBe("queued");
    expect(failBlocked?.waiting).toBe(true);
    expect(failBlocked?.reason).toMatch(/unsatisfiable_dependency: .*failed/);
  });

  test("incomplete prerequisite does not release a dependent", async () => {
    process.env.OAR_FAKE_OMO_MODE = "incomplete";
    const finished = waitEvents(
      daemon,
      (event) => event.type === "queue:job-finished" && event.status === "incomplete",
      1,
    );
    await enableSchedule(2);
    const prereq = await addJob("incomplete-prereq", { maxAttempts: 1 });
    const dependent = await addJob("needs-done", { dependsOn: [prereq.id] });
    await finished;
    const listed = asTasks((await client.request({ protocol: 1, action: "queue-list" })).data) as QueueTaskView[];
    expect(listed.find((task) => task.id === prereq.id)?.status).toBe("incomplete");
    const blocked = listed.find((task) => task.id === dependent.id);
    expect(blocked?.status).toBe("queued");
    expect(blocked?.waiting).toBe(true);
    expect(blocked?.reason).toMatch(/unsatisfiable_dependency: .*incomplete/);
  });
});

describe("queue setup failures", () => {
  function setupFailureManager(opts: {
    rootDir: string;
    repo: string;
    isolateWorktree: (opts: { repository: string; worktreeDir: string }) => { ok: true } | { ok: false; error: string };
    runner?: QueueRunner;
  }) {
    const store = new QueueStore({ rootDir: opts.rootDir });
    const manager = new QueueManager({
      store,
      schedule: () => ENABLED_SCHEDULE,
      now: () => KST_MIDNIGHT,
      runner: opts.runner ?? (async () => ({ code: 0, signal: null, stdout: "", stderr: "" })),
      isolateWorktree: opts.isolateWorktree,
      emit: () => {},
      retryDelayMs: 0,
      sleep: async () => {},
    });
    return { store, manager };
  }

  test("a transient worktree failure consumes one attempt and retries to success", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-setup-retry-"));
    const repo = join(root, "repo");
    initRepo(repo);
    let isolateCalls = 0;
    const { store, manager } = setupFailureManager({
      rootDir: join(root, "oar"),
      repo,
      isolateWorktree: () => {
        isolateCalls += 1;
        return isolateCalls === 1 ? { ok: false, error: "transient disk error" } : { ok: true };
      },
      runner: async () => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: OAR_RESULT_DONE }],
            stopReason: "stop",
          },
        }),
        stderr: "",
      }),
    });
    try {
      const task = store.add({
        prompt: "work",
        repository: repo,
        maxAttempts: 3,
        nowMs: KST_MIDNIGHT,
      });
      await manager.reconcile();
      const after = await waitForStatus(store, task.id, "completed");
      expect(after.attempts).toBe(2);
      expect(after.attemptHistory).toHaveLength(2);
      expect(after.attemptHistory[0]).toMatchObject({
        attempt: 1,
        cause: "setup_failed",
        verdict: "failed",
        reason: "setup_failed: transient disk error",
      });
      expect(after.attemptHistory[1]).toMatchObject({ attempt: 2, cause: "done", verdict: "completed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a persistent worktree failure exhausts the budget and leaves an artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "oar-setup-exhaust-"));
    const repo = join(root, "repo");
    initRepo(repo);
    const { store, manager } = setupFailureManager({
      rootDir: join(root, "oar"),
      repo,
      isolateWorktree: () => ({ ok: false, error: "disk full" }),
    });
    try {
      const task = store.add({
        prompt: "work",
        repository: repo,
        maxAttempts: 3,
        nowMs: KST_MIDNIGHT,
      });
      await manager.reconcile();
      const after = await waitForStatus(store, task.id, "failed");
      expect(after.attempts).toBe(3);
      expect(after.attemptHistory).toHaveLength(3);
      expect(after.reason).toBe("setup_failed: disk full");
      expect(after.error).toBe("setup_failed: disk full");
      expect(after.attemptHistory.every((item) => item.cause === "setup_failed")).toBe(true);
      const artifact = join(store.attemptArtifactDir(task.id, 3), "setup-error.txt");
      expect(existsSync(artifact)).toBe(true);
      expect(readFileSync(artifact, "utf8").trim()).toBe("disk full");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queue completion contract", () => {
  test("composeQueuePrompt keeps original prompt bytes verbatim", () => {
    const userPrompt = "-evil @/tmp/secret --help";
    const first = composeQueuePrompt({ userPrompt });
    expect(first.includes(userPrompt)).toBe(true);
    expect(first.startsWith(userPrompt)).toBe(true);
    expect(first).toContain(QUEUE_COMPLETION_CONTRACT);
    const again = composeQueuePrompt({ userPrompt, continuation: true, priorReason: "missing_sentinel" });
    expect(again.includes(userPrompt)).toBe(true);
    expect(again).toContain(QUEUE_CONTINUATION_PREAMBLE);
    expect(again.indexOf(userPrompt)).toBeGreaterThan(again.indexOf(QUEUE_CONTINUATION_PREAMBLE));
    const fresh = composeQueuePrompt({
      userPrompt,
      continuation: true,
      continuationKind: "fresh",
      priorReason: OAR_BRAKE_MARKER,
    });
    expect(fresh).toContain(QUEUE_FRESH_CONTINUATION_PREAMBLE);
    expect(fresh).not.toContain(QUEUE_CONTINUATION_PREAMBLE);
    expect(fresh).toContain(`Prior result: ${OAR_BRAKE_MARKER}`);
    expect(fresh.includes(userPrompt)).toBe(true);
  });

  test("judgeQueueRun follows the machine-checked verdict rules", () => {
    expect(
      judgeQueueRun({
        code: 0,
        signal: null,
        stdout: assistantStdout(`ok\n${OAR_RESULT_DONE}`),
        stderr: "",
      }),
    ).toMatchObject({ verdict: "completed", reason: "done", sessionId: "sess-1" });
    expect(
      judgeQueueRun({
        code: 0,
        signal: null,
        stdout: assistantStdout("OAR_RESULT: INCOMPLETE: still exploring"),
        stderr: "",
      }),
    ).toMatchObject({ verdict: "incomplete", reason: "still exploring" });
    expect(
      judgeQueueRun({
        code: 0,
        signal: null,
        stdout: assistantStdout("I am done in prose only"),
        stderr: "",
      }),
    ).toMatchObject({ verdict: "incomplete", reason: "missing_sentinel" });
    expect(
      judgeQueueRun({ code: 2, signal: null, stdout: assistantStdout("boom"), stderr: "" }),
    ).toMatchObject({ verdict: "failed", reason: "exit:2", sessionId: "sess-1" });
    expect(
      judgeQueueRun({
        code: 0,
        signal: null,
        stdout: `${assistantStdout("")}\n${JSON.stringify({
          type: "tool_execution_end",
          result: { content: [{ type: "text", text: OAR_BRAKE_MARKER }] },
        })}`,
        stderr: "",
      }),
    ).toMatchObject({ verdict: "incomplete", reason: OAR_BRAKE_MARKER });
    expect(
      judgeQueueRun({
        code: 0,
        signal: null,
        stdout: assistantStdout("An internal error occurred while processing your request.", {
          stopReason: "error",
          errorMessage: "An internal error occurred while processing your request.",
        }),
        stderr: "",
      }),
    ).toMatchObject({
      verdict: "incomplete",
      reason: "provider_error: An internal error occurred while processing your request.",
    });
  });
});

describe("real OMO prompt parser", () => {
  test.skipIf(!OMO_BIN)(
    "keeps leading-dash and standalone @path prompts from stdin",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "oar-omo-parse-"));
      const secret = join(tmp, "secret.txt");
      writeFileSync(secret, "FILECONTENTS", "utf8");
      const prompts = ["-evil --help", `@${secret}`];
      try {
        for (const prompt of prompts) {
          const dump = join(tmp, `dump-${Buffer.from(prompt).toString("hex")}.txt`);
          const args = [
            "--offline",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
            "--no-themes",
            "--no-prompt-templates",
            "--no-approve",
            "--no-tools",
            "-e",
            OMO_DUMP,
            ...buildOmoArgv({
              modelSelector: "opengateway/deepseek/deepseek-v4.1-flash-ultrafast",
            }),
          ];
          const child = spawn(OMO_BIN!, args, {
            cwd: tmp,
            env: {
              ...process.env,
              OAR_OMO_PROMPT_DUMP: dump,
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.stdin.on("error", () => {});
          child.stdin.end(prompt, "utf8");
          const dumped = await waitForFile(dump, 20_000);
          expect(dumped).toBe(prompt);
          child.kill("SIGKILL");
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    { timeout: 30_000 },
  );
});
