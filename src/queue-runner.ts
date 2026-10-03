import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QueueAttemptCause, QueueSessionMode, QueueVerdict } from "./queue-store.ts";

export type QueueContinuationKind = QueueSessionMode;

export type QueueRunRequest = {
  id: string;
  prompt: string;
  cwd: string;
  modelSelector: string;
  artifactDir: string;
  sessionId?: string;
  continuation?: boolean;
  continuationKind?: QueueContinuationKind;
  priorReason?: string;
};

export type QueueRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type QueueRunJudgment = {
  verdict: QueueVerdict;
  reason: string;
  cause: QueueAttemptCause;
  sessionId?: string;
};

export type QueueRunner = (req: QueueRunRequest, signal: AbortSignal) => Promise<QueueRunResult>;

export type OmoCommand = {
  bin: string;
  prefixArgs?: string[];
};

export type IsolateWorktree = (opts: {
  repository: string;
  worktreeDir: string;
}) => { ok: true } | { ok: false; error: string };

export const OAR_RESULT_DONE = "OAR_RESULT: DONE";
export const OAR_RESULT_INCOMPLETE_PREFIX = "OAR_RESULT: INCOMPLETE:";
export const OAR_BRAKE_MARKER = "omo-brake paused";
export const OAR_BRAKE_EXHAUSTED_REASON = "omo-brake paused: attempts exhausted";

export const QUEUE_COMPLETION_CONTRACT = [
  "----- OAR completion contract -----",
  "End your final message with exactly one sentinel line:",
  OAR_RESULT_DONE,
  "If you could not finish, end with exactly one sentinel line:",
  `${OAR_RESULT_INCOMPLETE_PREFIX} <reason>`,
  "Do not write anything after the sentinel line.",
].join("\n");

export const QUEUE_CONTINUATION_PREAMBLE =
  "The previous attempt ended without completion. You must now finish the job and end with the sentinel.";

export const QUEUE_FRESH_CONTINUATION_PREAMBLE =
  "The previous session is not being reused. Continue from the artifacts on disk and finish the job, then end with the sentinel.";

export function composeQueuePrompt(opts: {
  userPrompt: string;
  continuation?: boolean;
  continuationKind?: QueueContinuationKind;
  priorReason?: string;
}): string {
  const parts: string[] = [];
  if (opts.continuation) {
    parts.push(
      opts.continuationKind === "fresh" ? QUEUE_FRESH_CONTINUATION_PREAMBLE : QUEUE_CONTINUATION_PREAMBLE,
    );
    if (opts.priorReason) parts.push(`Prior result: ${opts.priorReason}`);
    parts.push("");
  }
  parts.push(opts.userPrompt);
  parts.push(QUEUE_COMPLETION_CONTRACT);
  return parts.join("\n");
}

export function buildOmoArgv(opts: { modelSelector: string; sessionId?: string }): string[] {
  const args = [
    "--mode",
    "json",
    "--model",
    opts.modelSelector,
    "--no-model-fallback",
    "--no-ask-user",
  ];
  if (opts.sessionId) {
    args.push("--session", opts.sessionId);
  }
  args.push("-p");
  return args;
}

export function inspectRepositoryPath(repository: string): { ok: true } | { ok: false; error: string } {
  if (!repository) return { ok: false, error: "repository is required" };
  if (!existsSync(repository)) return { ok: false, error: `repository not found: ${repository}` };
  try {
    if (!statSync(repository).isDirectory()) {
      return { ok: false, error: `repository is not a directory: ${repository}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

export function inspectRepository(repository: string): { ok: true } | { ok: false; error: string } {
  const path = inspectRepositoryPath(repository);
  if (!path.ok) return path;
  const inside = spawnSync("git", ["-C", repository, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return {
      ok: false,
      error: "Not a git repository; pass --isolate none to run in this directory.",
    };
  }
  const head = spawnSync("git", ["-C", repository, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  });
  if (head.status !== 0) {
    return { ok: false, error: "unsuitable repository: no commits" };
  }
  return { ok: true };
}

export function addIsolatedWorktree(opts: {
  repository: string;
  worktreeDir: string;
}): { ok: true } | { ok: false; error: string } {
  mkdirSync(dirname(opts.worktreeDir), { recursive: true, mode: 0o700 });
  if (existsSync(opts.worktreeDir)) {
    return { ok: false, error: `worktree path already exists: ${opts.worktreeDir}` };
  }
  const added = spawnSync(
    "git",
    ["-C", opts.repository, "worktree", "add", "--detach", opts.worktreeDir, "HEAD"],
    { encoding: "utf8" },
  );
  if (added.status !== 0) {
    const detail = (added.stderr || added.stdout || "git worktree add failed").trim();
    return { ok: false, error: `worktree isolation failed: ${detail}` };
  }
  return { ok: true };
}

function writePromptArtifacts(artifactDir: string, userPrompt: string, composed: string): void {
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(artifactDir, "user-prompt.txt"), userPrompt, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(artifactDir, "prompt.txt"), composed, { encoding: "utf8", mode: 0o600 });
}

export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid == null) return;
  if (process.platform === "win32") {
    const force = signal === "SIGKILL";
    const args = force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
    try {
      spawn("taskkill", args, { stdio: "ignore" });
    } catch {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkerJsonStream(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // ignore non-JSON lines
    }
  }
  return events;
}

export function extractSessionId(stdout: string): string | undefined {
  for (const event of parseWorkerJsonStream(stdout)) {
    if (event.type === "session" && typeof event.id === "string" && event.id.length > 0) {
      return event.id;
    }
  }
  return undefined;
}

function assistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("");
}

type AssistantInfo = {
  text: string;
  stopReason?: string;
  errorMessage?: string;
};

function considerAssistant(
  message: Record<string, unknown>,
  last: AssistantInfo | undefined,
): AssistantInfo | undefined {
  if (message.role !== "assistant") return last;
  return {
    text: assistantText(message),
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
  };
}

export function extractLastAssistant(stdout: string): AssistantInfo | undefined {
  let last: AssistantInfo | undefined;
  for (const event of parseWorkerJsonStream(stdout)) {
    if (isRecord(event.message)) last = considerAssistant(event.message, last);
    if (Array.isArray(event.messages)) {
      for (const item of event.messages) {
        if (isRecord(item)) last = considerAssistant(item, last);
      }
    }
    if (event.role === "assistant") last = considerAssistant(event, last);
  }
  return last;
}

export function hasDoneSentinel(text: string): boolean {
  return /(?:^|\n)OAR_RESULT: DONE(?:\r?\n|$)/.test(text);
}

export function extractIncompleteReason(text: string): string | undefined {
  const matches = [...text.matchAll(/(?:^|\n)OAR_RESULT: INCOMPLETE: ([^\r\n]*)/g)];
  const last = matches.at(-1);
  if (!last) return undefined;
  const reason = (last[1] ?? "").trim();
  return reason.length > 0 ? reason : "incomplete";
}

export function judgeQueueRun(result: QueueRunResult): QueueRunJudgment {
  const sessionId = extractSessionId(result.stdout);
  const assistant = extractLastAssistant(result.stdout);

  if (result.code !== 0) {
    return {
      verdict: "failed",
      reason: result.signal ? `signal:${result.signal}` : `exit:${result.code ?? "unknown"}`,
      cause: result.signal ? "signal" : "exit",
      sessionId,
    };
  }

  if (result.stdout.includes(OAR_BRAKE_MARKER)) {
    return { verdict: "incomplete", reason: OAR_BRAKE_MARKER, cause: "brake_paused", sessionId };
  }

  if (assistant && (assistant.stopReason === "error" || assistant.errorMessage)) {
    return {
      verdict: "incomplete",
      reason: assistant.errorMessage
        ? `provider_error: ${assistant.errorMessage}`
        : "provider_error",
      cause: "provider_error",
      sessionId,
    };
  }

  const text = assistant?.text ?? "";
  if (hasDoneSentinel(text)) {
    return { verdict: "completed", reason: "done", cause: "done", sessionId };
  }
  const incomplete = extractIncompleteReason(text);
  if (incomplete !== undefined) {
    return { verdict: "incomplete", reason: incomplete, cause: "incomplete_sentinel", sessionId };
  }
  return { verdict: "incomplete", reason: "missing_sentinel", cause: "missing_sentinel", sessionId };
}

export function createOmoQueueRunner(command: OmoCommand = { bin: "omo" }): QueueRunner {
  const prefix = command.prefixArgs ?? [];
  return (req, signal) => {
    const composed = composeQueuePrompt({
      userPrompt: req.prompt,
      continuation: req.continuation,
      continuationKind: req.continuationKind,
      priorReason: req.priorReason,
    });
    writePromptArtifacts(req.artifactDir, req.prompt, composed);
    const args = [
      ...prefix,
      ...buildOmoArgv({ modelSelector: req.modelSelector, sessionId: req.sessionId }),
    ];
    writeFileSync(join(req.artifactDir, "argv.json"), JSON.stringify(args, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    const stdoutPath = join(req.artifactDir, "stdout.log");
    const stderrPath = join(req.artifactDir, "stderr.log");
    writeFileSync(stdoutPath, "", { encoding: "utf8", mode: 0o600 });
    writeFileSync(stderrPath, "", { encoding: "utf8", mode: 0o600 });

    return new Promise<QueueRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(command.bin, args, {
          cwd: req.cwd,
          env: { ...process.env, OAR_QUEUE_JOB_ID: req.id },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      child.stdin?.on("error", () => {});
      try {
        child.stdin?.end(composed, "utf8");
      } catch {
        // child already closed stdin
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: QueueRunResult) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const onAbort = () => {
        if (child.exitCode != null || child.signalCode != null) return;
        terminateProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) {
            terminateProcessTree(child, "SIGKILL");
          }
        }, 1000);
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stdout += text;
        appendFileSync(stdoutPath, text);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderr += text;
        appendFileSync(stderrPath, text);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code, closeSignal) => {
        finish({ code, signal: closeSignal, stdout, stderr });
      });

      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    });
  };
}
