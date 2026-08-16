/**
 * Thin Senpi extension for OAR.
 *
 * Model routing stays in OMO/Senpi. This extension:
 *  - exposes /account commands
 *  - reconnects to the daemon (OAR restart must not require OMO restart)
 *  - reports provider HTTP failures so the daemon can mark AUTH_REVOKED / RATE_LIMITED
 *  - acquires a request-scoped lease (same provider account is shared; see architecture)
 *
 * Hot switch itself is auth.json slot activation. getAuth already ran before
 * before_provider_request, so a switch applies to the *next* eligible request.
 *
 * Install:
 *   mkdir -p ~/.omo/agent/extensions
 *   ln -sf /absolute/path/to/omo-account-router/extensions/oar-senpi.js ~/.omo/agent/extensions/oar.js
 */
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

async function request(body, retries = 5) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await requestOnce(body, 4000);
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

function classifyStatus(status, headers) {
  if (status === 429) return "RATE_LIMITED";
  if (status === 401) return "AUTH_EXPIRED";
  if (status === 402) return "QUOTA_EXHAUSTED";
  if (status >= 500) return "SERVER_ERROR";
  if (status === 400) {
    const retry = headers && (headers["retry-after"] || headers["Retry-After"]);
    if (retry) return "RATE_LIMITED";
    return null;
  }
  return null;
}

export default function (pi) {
  const holder = `omo:${process.pid}:${process.env.SENPI_TASK_ID || process.env.OMO_MEMBER || "session"}`;
  let last = { provider: null, profile: null, leaseId: null };

  pi.on("before_provider_request", async (event) => {
    const provider = event?.model?.provider;
    if (!provider) return;
    try {
      const resolved = await request({ protocol: 1, action: "resolve", provider, member: holder });
      if (!resolved.ok) {
        if (resolved.error && /unavailable|no eligible|daemon/i.test(resolved.error)) {
          pi.notify?.(`OAR: ${resolved.error}`, "error");
        }
        return;
      }
      last.provider = provider;
      last.profile = resolved.data?.profile;
      const lease = await request({
        protocol: 1,
        action: "acquire-lease",
        provider,
        profile: last.profile,
        holder,
      });
      if (lease.ok) last.leaseId = lease.data?.id;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (process.env.OAR_DEBUG) pi.notify?.(`OAR resolve failed: ${msg}`, "warning");
    }
  });

  pi.on("after_provider_response", async (event) => {
    try {
      if (last.leaseId) {
        await request({ protocol: 1, action: "release-lease", leaseId: last.leaseId });
        last.leaseId = null;
      }
      if (!last.provider || !last.profile) return;
      const result = classifyStatus(event?.status, event?.headers);
      if (!result) {
        await request({
          protocol: 1,
          action: "report",
          provider: last.provider,
          account: last.profile,
          result: "SUCCESS",
        });
        return;
      }
      if (result === "SERVER_ERROR") return;
      await request({
        protocol: 1,
        action: "report",
        provider: last.provider,
        account: last.profile,
        result,
      });
    } catch {
      // never break the agent loop
    }
  });

  pi.registerCommand("account", {
    description: "OAR account router (status|use|auto|doctor)",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "status";
      try {
        if (sub === "status") {
          const res = await request({ protocol: 1, action: "status" });
          if (!res.ok) throw new Error(res.error);
          const lines = (res.data.accounts || []).map((a) => {
            const star = (res.data.resolvePreview || []).some(
              (p) => p.provider === a.provider && p.profile === a.profile && p.status === "available",
            )
              ? "★"
              : " ";
            return `${star} ${a.provider}/${a.profile} ${a.auth} ${a.availability}`;
          });
          ctx.ui.notify(lines.join("\n") || "no accounts", "info");
          return;
        }
        if (sub === "use") {
          const provider = parts[1];
          const profile = parts[2];
          if (!provider || !profile) {
            ctx.ui.notify("usage: /account use <provider> <profile>", "warning");
            return;
          }
          const res = await request({ protocol: 1, action: "use", provider, profile });
          if (!res.ok) throw new Error(res.error);
          ctx.ui.notify(res.data.message || `using ${provider}/${profile}`, "info");
          return;
        }
        if (sub === "auto") {
          const provider = parts[1];
          const onoff = parts[2];
          if (!provider || (onoff !== "on" && onoff !== "off")) {
            ctx.ui.notify("usage: /account auto <provider> on|off", "warning");
            return;
          }
          const res = await request({
            protocol: 1,
            action: "auto",
            provider,
            enabled: onoff === "on",
          });
          if (!res.ok) throw new Error(res.error);
          ctx.ui.notify(JSON.stringify(res.data), "info");
          return;
        }
        if (sub === "doctor") {
          const res = await request({ protocol: 1, action: "doctor" });
          if (!res.ok) throw new Error(res.error);
          ctx.ui.notify(JSON.stringify(res.data, null, 2), "info");
          return;
        }
        ctx.ui.notify("usage: /account status|use|auto|doctor", "warning");
      } catch (error) {
        ctx.ui.notify(
          `OAR: ${error instanceof Error ? error.message : String(error)}. Is daemon running? oar daemon start`,
          "error",
        );
      }
    },
  });
}
