#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, watch } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
writeFileSync(join(process.cwd(), "argv.json"), JSON.stringify(args), { encoding: "utf8" });

let stdinText = "";
try {
  stdinText = readFileSync(0, { encoding: "utf8" });
} catch {
  stdinText = "";
}
writeFileSync(join(process.cwd(), "stdin.txt"), stdinText, { encoding: "utf8" });

const control = process.env.OAR_FAKE_OMO_CONTROL;
const id = process.env.OAR_QUEUE_JOB_ID;
const mode = process.env.OAR_FAKE_OMO_MODE ?? "complete";

if (control && id) {
  writeFileSync(join(control, `${id}.started`), "1", { encoding: "utf8" });
  writeFileSync(join(control, `${id}.argv`), JSON.stringify(args), { encoding: "utf8" });
  writeFileSync(join(control, `${id}.stdin`), stdinText, { encoding: "utf8" });
}

const sessionFromArgs = (() => {
  const idx = args.indexOf("--session");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  if (process.env.OAR_FAKE_OMO_SESSION) return process.env.OAR_FAKE_OMO_SESSION;
  if (control && id) {
    const seqPath = join(control, `${id}.fresh-seq`);
    const next = existsSync(seqPath) ? Number(readFileSync(seqPath, "utf8")) + 1 : 1;
    writeFileSync(seqPath, String(next));
    return next === 1 ? `fake-${id}` : `fake-${id}-${next}`;
  }
  return id ? `fake-${id}` : "fake-anon";
})();

function writeJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitSession() {
  writeJson({ type: "session", version: 3, id: sessionFromArgs });
  if (control && id) {
    writeFileSync(join(control, `${id}.session`), sessionFromArgs, { encoding: "utf8" });
  }
}

function emitAssistant(text, extra = {}) {
  writeJson({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      ...extra,
    },
  });
}

const exitWith = (code) => {
  writeFileSync(join(process.cwd(), "done.txt"), String(code), { encoding: "utf8" });
  process.exit(code);
};

function finishComplete() {
  emitSession();
  emitAssistant(`work finished\nOAR_RESULT: DONE`);
  exitWith(0);
}

function finishFail() {
  emitSession();
  emitAssistant("boom");
  exitWith(2);
}

function finishIncomplete() {
  emitSession();
  emitAssistant(`not done\nOAR_RESULT: INCOMPLETE: reconnaissance only`);
  exitWith(0);
}

function finishNoSentinel() {
  emitSession();
  emitAssistant("I looked around and stopped.");
  exitWith(0);
}

function finishBrake() {
  emitSession();
  writeJson({
    type: "tool_execution_end",
    result: { content: [{ type: "text", text: "omo-brake paused" }], terminate: true },
    isError: true,
  });
  exitWith(0);
}

function finishProviderError() {
  emitSession();
  emitAssistant("An internal error occurred while processing your request.", {
    stopReason: "error",
    errorMessage: "An internal error occurred while processing your request.",
  });
  exitWith(0);
}

process.on("SIGTERM", () => {
  writeFileSync(join(process.cwd(), "terminated.txt"), "1", { encoding: "utf8" });
  if (control && id) writeFileSync(join(control, `${id}.terminated`), "1", { encoding: "utf8" });
  process.exit(143);
});

function spawnGrandchild() {
  if (!control || !id) return;
  const pidPath = join(control, `${id}.child-pid`);
  const deadPath = join(control, `${id}.child-dead`);
  const script = `
    const { writeFileSync } = require("node:fs");
    writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    const stop = () => {
      try { writeFileSync(${JSON.stringify(deadPath)}, "1"); } catch {}
      process.exit(0);
    };
    process.on("SIGHUP", () => {});
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    setInterval(() => {}, 1 << 30);
  `;
  spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

if (mode === "fail") finishFail();
if (mode === "complete") finishComplete();
if (mode === "incomplete") finishIncomplete();
if (mode === "no-sentinel" || mode === "nosentinel") finishNoSentinel();
if (mode === "brake") finishBrake();
if (mode === "provider-error") finishProviderError();

if (mode === "hang") {
  emitSession();
  spawnGrandchild();
}

if (control && id) {
  const names = {
    release: `${id}.release`,
    fail: `${id}.fail`,
    incomplete: `${id}.incomplete`,
    nosentinel: `${id}.nosentinel`,
    brake: `${id}.brake`,
    provider: `${id}.provider-error`,
  };
  const paths = {
    release: join(control, names.release),
    fail: join(control, names.fail),
    incomplete: join(control, names.incomplete),
    nosentinel: join(control, names.nosentinel),
    brake: join(control, names.brake),
    provider: join(control, names.provider),
  };
  if (existsSync(paths.release)) finishComplete();
  if (existsSync(paths.fail)) finishFail();
  if (existsSync(paths.incomplete)) finishIncomplete();
  if (existsSync(paths.nosentinel)) finishNoSentinel();
  if (existsSync(paths.brake)) finishBrake();
  if (existsSync(paths.provider)) finishProviderError();
  watch(control, (_event, filename) => {
    if (filename === names.release || filename === `${names.release}`) finishComplete();
    if (filename === names.fail || filename === `${names.fail}`) finishFail();
    if (filename === names.incomplete || filename === `${names.incomplete}`) finishIncomplete();
    if (filename === names.nosentinel || filename === `${names.nosentinel}`) finishNoSentinel();
    if (filename === names.brake || filename === `${names.brake}`) finishBrake();
    if (filename === names.provider || filename === `${names.provider}`) finishProviderError();
  });
}
