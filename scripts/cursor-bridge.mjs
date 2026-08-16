#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible bridge → Cursor CLI (cursor-agent).
 *
 * Burns the Cursor Models pool (Composer / Cursor Grok) from any client that
 * speaks POST /v1/chat/completions — including a Senpi/OMO custom provider.
 *
 * Limits (honest):
 * - This is NOT official Cursor chat-completions API.
 * - Tool/function calling is not mapped to OMO tools; cursor-agent runs its
 *   own agent loop with its own tools when given a prompt.
 * - Best used for delegated coding prompts or as a secondary model, not as a
 *   drop-in for full OMO tool-parity streaming.
 *
 * Env:
 *   CURSOR_BRIDGE_PORT   default 18765
 *   CURSOR_BRIDGE_HOST   default 127.0.0.1
 *   CURSOR_BRIDGE_MODEL  default cursor-grok-4.6-high
 *   CURSOR_API_KEY       optional; cursor-agent also uses login session
 *   CURSOR_AGENT_BIN     default cursor-agent
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = process.env.CURSOR_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.CURSOR_BRIDGE_PORT || 18765);
const DEFAULT_MODEL = process.env.CURSOR_BRIDGE_MODEL || "cursor-grok-4.6-high";
const AGENT = process.env.CURSOR_AGENT_BIN || "cursor-agent";

const STATIC_MODELS = [
  "cursor-grok-4.6-high",
  "cursor-grok-4.6-high-fast",
  "cursor-grok-4.6-medium",
  "cursor-grok-4.5-high",
  "composer-2.5",
  "composer-2.5-fast",
];

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function messagesToPrompt(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      const role = m.role || "user";
      const content =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("")
            : JSON.stringify(m.content ?? "");
      return `${role.toUpperCase()}:\n${content}`;
    })
    .join("\n\n");
}

function runCursorAgent(model, prompt, signal) {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format",
      "text",
      "--model",
      model,
      "--force",
      "--trust",
      prompt,
    ];
    const child = spawn(AGENT, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(stdout.trim() || "(empty cursor-agent response)");
      else reject(new Error(stderr.trim() || `cursor-agent exited ${code}`));
    });
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
      return json(res, 200, { ok: true, agent: AGENT, defaultModel: DEFAULT_MODEL });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, {
        object: "list",
        data: STATIC_MODELS.map((id) => ({ id, object: "model", owned_by: "cursor-bridge" })),
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readBody(req);
      const model = body.model || DEFAULT_MODEL;
      const prompt = messagesToPrompt(body.messages);
      if (!prompt.trim()) return json(res, 400, { error: { message: "empty messages" } });
      const text = await runCursorAgent(model, prompt);
      const id = `chatcmpl_cursor_${Date.now()}`;
      if (body.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunk = {
          id,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return json(res, 200, {
        id,
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    json(res, 404, { error: { message: `not found: ${url.pathname}` } });
  } catch (error) {
    json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
  }
});

server.listen(PORT, HOST, () => {
  const logPath = join(homedir(), "Library", "Logs", "oar-cursor-bridge.log");
  console.log(`oar cursor-bridge on http://${HOST}:${PORT}  (log hint: ${logPath})`);
  console.log(`default model: ${DEFAULT_MODEL}  agent: ${AGENT}`);
});
