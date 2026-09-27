import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

function socketPath() {
  return process.env.OAR_SOCK || join(process.env.OAR_HOME || join(homedir(), ".oar"), "oar.sock");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOnce(body, timeoutMs) {
  const payload = Buffer.concat([Buffer.from(JSON.stringify(body), "utf8"), Buffer.from([0])]);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath());
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("OAR daemon timeout"));
    }, timeoutMs);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(0);
      if (idx === -1) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buf.subarray(0, idx).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function request(body, retries = 5) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await requestOnce(body, 5000);
    } catch (error) {
      last = error;
      const msg = error instanceof Error ? error.message : String(error);
      const retryable = msg.includes("ENOENT") || msg.includes("ECONNREFUSED") || msg.includes("timeout");
      if (!retryable || i === retries) throw error;
      await sleep(50 * 2 ** i);
    }
  }
  throw last;
}

function headerText(headers) {
  if (!headers || typeof headers !== "object") return "";
  return Object.entries(headers)
    .flatMap(([key, value]) => {
      if (value == null) return [];
      return [key, Array.isArray(value) ? value.join(" ") : String(value)];
    })
    .join(" ")
    .toLowerCase();
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle) return value;
  }
  return undefined;
}

export function classifyStatus(status, headers, body) {
  const text = `${String(body || "")} ${headerText(headers)}`.toLowerCase();
  if (status === 429) return "RATE_LIMITED";
  if (status === 401) {
    if (text.includes("invalid_grant") || text.includes("revok")) return "AUTH_REVOKED";
    return "AUTH_EXPIRED";
  }
  if (status === 402) return "QUOTA_EXHAUSTED";
  if (
    text.includes("invalid_grant") ||
    text.includes("refresh token has been revoked") ||
    text.includes("token has been revoked")
  ) {
    return "AUTH_REVOKED";
  }
  if (
    status === 403 ||
    text.includes("run out of credits") ||
    text.includes("out of credits") ||
    text.includes("need a grok subscription") ||
    text.includes("insufficient_quota") ||
    text.includes("usage limit")
  ) {
    return "QUOTA_EXHAUSTED";
  }
  if (status >= 500) return "SERVER_ERROR";
  if (status === 400) {
    if (headerValue(headers, "retry-after")) return "RATE_LIMITED";
    if (text.includes("invalid_grant") || text.includes("invalid_token")) return "AUTH_REVOKED";
  }
  return null;
}

export async function bootstrapAuto(pi) {
  try {
    const res = await request({ protocol: 1, action: "bootstrap-auto" });
    if (!res.ok) {
      if (process.env.OAR_DEBUG) pi.notify?.(`OAR bootstrap: ${res.error}`, "warning");
      return;
    }
    const enabled = res.data?.enabled || [];
    if (enabled.length && process.env.OAR_DEBUG) {
      const summary = enabled.map((entry) => `${entry.provider}(${entry.profiles})`).join(", ");
      pi.notify?.(`OAR auto-on: ${summary}`, "info");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (process.env.OAR_DEBUG) pi.notify?.(`OAR daemon offline (${msg})`, "warning");
  }
}
