import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { OarClient } from "../src/client.ts";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";
import type { PromotionStatusView } from "../src/promotion.ts";
import type { QueueTask } from "../src/queue-store.ts";

const KST_MIDNIGHT = Date.parse("2026-10-02T15:00:00.000Z");

async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return { value: await fn(), logs };
  } finally {
    console.log = orig;
  }
}

describe("schedule and queue CLI", () => {
  let root: string;
  let sock: string;
  let daemon: OarDaemon;
  const prevHome = process.env.OAR_HOME;
  const prevSock = process.env.OAR_SOCK;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-sched-cli-"));
    sock = join(root, "oar.sock");
    process.env.OAR_HOME = root;
    process.env.OAR_SOCK = sock;
    daemon = new OarDaemon({
      store: new OarStore({ rootDir: root }),
      socketPath: sock,
      activateOnUse: false,
      now: () => KST_MIDNIGHT,
      queueRunner: async () => ({
        code: 0,
        signal: null,
        stdout: [
          JSON.stringify({ type: "session", id: "cli-session" }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "OAR_RESULT: DONE" }] },
          }),
        ].join("\n"),
        stderr: "",
      }),
    });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    if (prevHome === undefined) delete process.env.OAR_HOME;
    else process.env.OAR_HOME = prevHome;
    if (prevSock === undefined) delete process.env.OAR_SOCK;
    else process.env.OAR_SOCK = prevSock;
    rmSync(root, { recursive: true, force: true });
  });

  test("help documents schedule and queue", async () => {
    const { logs } = await withCapturedLogs(() => runCli(["-h"]));
    const text = logs.join("\n");
    expect(text).toContain("oar schedule configure");
    expect(text).toContain("oar schedule status");
    expect(text).toContain("oar schedule off");
    expect(text).toContain("oar queue add");
    expect(text).toContain("--isolate worktree|none");
    expect(text).toContain("oar queue list");
    expect(text).toContain("oar queue cancel");
    expect(text).toContain("oar queue retry");
    expect(text).toContain("--max-attempts");
    expect(text).toContain("--depends-on");
  });

  test("rejects unknown --isolate before the daemon request", async () => {
    await expect(
      runCli(["queue", "add", "--repo", root, "--prompt", "x", "--isolate", "copy"]),
    ).rejects.toThrow(/unknown isolation strategy: copy/i);
  });

  test("configure, status, off, and queue add/list/cancel go through the daemon", async () => {
    const configured = await withCapturedLogs(() =>
      runCli(["schedule", "configure", "--concurrency", "2", "--json"]),
    );
    const status = JSON.parse(configured.logs.join("\n")) as PromotionStatusView;
    expect(status.enabled).toBe(true);
    expect(status.inWindow).toBe(true);
    expect(status.maxConcurrency).toBe(2);
    expect(status.modelSelector).toBe("opengateway/deepseek/deepseek-v4.1-flash-ultrafast");

    const promptFile = join(root, "prompt.txt");
    writeFileSync(promptFile, "-dash @/tmp/secret --help", "utf8");
    const added = await withCapturedLogs(() =>
      runCli(["queue", "add", "--repo", root, "--prompt-file", promptFile]),
    );
    const task = JSON.parse(added.logs.join("\n")) as QueueTask;
    expect(task.prompt).toBe("-dash @/tmp/secret --help");
    expect(task.status).toBe("failed");

    const listed = await withCapturedLogs(() => runCli(["queue", "list", "--json"]));
    const tasks = JSON.parse(listed.logs.join("\n")) as QueueTask[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.prompt).toBe("-dash @/tmp/secret --help");

    const client = new OarClient({ socketPath: sock });
    await withCapturedLogs(() => runCli(["schedule", "off"]));
    const afterOff = await client.request({ protocol: 1, action: "schedule-status" });
    expect(afterOff.ok).toBe(true);
    expect((afterOff.data as PromotionStatusView).enabled).toBe(false);

    const parked = await client.request({
      protocol: 1,
      action: "queue-add",
      prompt: "cancel me",
      repository: root,
    });
    expect(parked.ok).toBe(true);
    const parkedTask = parked.data as QueueTask;
    expect(parkedTask.status).toBe("queued");
    const cancelled = await withCapturedLogs(() => runCli(["queue", "cancel", parkedTask.id]));
    expect((JSON.parse(cancelled.logs.join("\n")) as QueueTask).status).toBe("cancelled");
  });

  test("queue add --isolate none is accepted for a non-git directory", async () => {
    await withCapturedLogs(() => runCli(["schedule", "configure"]));
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for isolate none job")), 4000);
      const off = daemon.onQueueEvent((event) => {
        if (event.type !== "queue:job-finished") return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    const added = await withCapturedLogs(() =>
      runCli(["queue", "add", "--repo", root, "--prompt", "in place", "--isolate", "none"]),
    );
    const task = JSON.parse(added.logs.join("\n")) as QueueTask;
    expect(task.isolation).toBe("none");
    await finished;
    const listed = await withCapturedLogs(() => runCli(["queue", "list", "--json"]));
    const tasks = JSON.parse(listed.logs.join("\n")) as QueueTask[];
    expect(tasks[0]?.isolation).toBe("none");
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.worktreeDir).toBeUndefined();
    expect(tasks[0]?.verdict).toBe("completed");
    expect(tasks[0]?.attempts).toBe(1);
  });

  test("queue retry re-arms a terminal incomplete task", async () => {
    await daemon.stop();
    let calls = 0;
    daemon = new OarDaemon({
      store: new OarStore({ rootDir: root }),
      socketPath: sock,
      activateOnUse: false,
      now: () => KST_MIDNIGHT,
      queueRetryDelayMs: 0,
      queueSleep: async () => {},
      queueRunner: async () => {
        calls += 1;
        return {
          code: 0,
          signal: null,
          stdout: [
            JSON.stringify({ type: "session", id: "retry-session" }),
            JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "OAR_RESULT: INCOMPLETE: still working" }],
              },
            }),
          ].join("\n"),
          stderr: "",
        };
      },
    });
    await daemon.start();
    await withCapturedLogs(() => runCli(["schedule", "configure", "--max-attempts", "1"]));
    const firstDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for first incomplete")), 4000);
      const off = daemon.onQueueEvent((event) => {
        if (event.type !== "queue:job-finished") return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    const added = await withCapturedLogs(() =>
      runCli(["queue", "add", "--repo", root, "--prompt", "retry me", "--isolate", "none", "--max-attempts", "1"]),
    );
    const task = JSON.parse(added.logs.join("\n")) as QueueTask;
    await firstDone;
    const listed = JSON.parse((await withCapturedLogs(() => runCli(["queue", "list", "--json"]))).logs.join("\n")) as QueueTask[];
    expect(listed[0]?.status).toBe("incomplete");
    expect(listed[0]?.attempts).toBe(1);

    const secondDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for retried incomplete")), 4000);
      const off = daemon.onQueueEvent((event) => {
        if (event.type !== "queue:job-finished") return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    await withCapturedLogs(() => runCli(["queue", "retry", task.id]));
    await secondDone;
    const finalListed = JSON.parse((await withCapturedLogs(() => runCli(["queue", "list", "--json"]))).logs.join("\n")) as QueueTask[];
    expect(finalListed[0]?.status).toBe("incomplete");
    expect(finalListed[0]?.attempts).toBe(1);
    expect(finalListed[0]?.sessionIds).toContain("retry-session");
    expect(calls).toBe(2);
  });

  test("queue add --depends-on round-trips through list JSON", async () => {
    await withCapturedLogs(() => runCli(["schedule", "off"]));
    const firstAdded = await withCapturedLogs(() =>
      runCli(["queue", "add", "--repo", root, "--prompt", "prereq", "--isolate", "none"]),
    );
    const first = JSON.parse(firstAdded.logs.join("\n")) as QueueTask;
    const secondAdded = await withCapturedLogs(() =>
      runCli([
        "queue",
        "add",
        "--repo",
        root,
        "--prompt",
        "child",
        "--isolate",
        "none",
        "--depends-on",
        first.id.slice(0, 8),
      ]),
    );
    const second = JSON.parse(secondAdded.logs.join("\n")) as QueueTask;
    expect(second.dependsOn).toEqual([first.id]);
    const listed = JSON.parse(
      (await withCapturedLogs(() => runCli(["queue", "list", "--json"]))).logs.join("\n"),
    ) as QueueTask[];
    expect(listed.find((task) => task.id === second.id)?.dependsOn).toEqual([first.id]);
    const human = await withCapturedLogs(() => runCli(["queue", "list"]));
    expect(human.logs.join("\n")).toContain("dependsOn=");
    expect(human.logs.join("\n")).toMatch(/waiting unmet=/);
  });
});
