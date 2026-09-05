/**
 * OAR ↔ OMO/Senpi integration (no manual `oar` required for day-to-day use).
 *
 * On session start:
 *   - bootstrap-auto (multi-profile providers → mode=auto + autoFailover)
 *   - preferred vault profile is ensureActivated into live auth.json
 *
 * Every provider request:
 *   - resolve preferred/eligible profile (daemon activates slot)
 *   - lease for concurrency accounting
 *
 * After provider response:
 *   - SUCCESS / AUTH_* / RATE_LIMIT / QUOTA reported to daemon
 *   - AUTH_EXPIRED tries daemon refresh first, then report (triggers failover)
 *   - automatic profile switch applies to the *next* request (getAuth runs first)
 *
 * Install (also done by scripts/install.sh / bootstrap-omo-oar.sh):
 *   ln -sf .../extensions/oar-senpi.js ~/.omo/agent/extensions/oar.js
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

/**
 * Senpi 2026.9.4 after_provider_response is status + headers only (no body).
 * Scan header haystack so invalid_grant / invalid_token still fail over.
 */
function classifyStatus(status, headers, body) {
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
    const retry = headerValue(headers, "retry-after");
    if (retry) return "RATE_LIMITED";
    if (text.includes("invalid_grant") || text.includes("invalid_token")) return "AUTH_REVOKED";
    return null;
  }
  return null;
}

async function bootstrapAuto(pi) {
  try {
    const res = await request({ protocol: 1, action: "bootstrap-auto" });
    if (!res.ok) {
      if (process.env.OAR_DEBUG) pi.notify?.(`OAR bootstrap: ${res.error}`, "warning");
      return;
    }
    const enabled = res.data?.enabled || [];
    if (enabled.length && process.env.OAR_DEBUG) {
      const summary = enabled.map((e) => `${e.provider}(${e.profiles})`).join(", ");
      pi.notify?.(`OAR auto-on: ${summary}`, "info");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (process.env.OAR_DEBUG) pi.notify?.(`OAR daemon offline (${msg})`, "warning");
  }
}

export default function (pi) {
  const holder = `omo:${process.pid}:${process.env.SENPI_TASK_ID || process.env.OMO_MEMBER || "session"}`;
  let last = { provider: null, profile: null, leaseId: null };
  let bootstrapped = false;

  pi.on("session_start", async () => {
    bootstrapped = true;
    await bootstrapAuto(pi);
  });

  // Some hosts skip session_start for short tasks — still bootstrap once.
  pi.on("before_provider_request", async (event) => {
    if (!bootstrapped) {
      bootstrapped = true;
      await bootstrapAuto(pi);
    }
    const provider = event?.model?.provider;
    if (!provider || provider === "cursor") return;
    try {
      const resolved = await request({ protocol: 1, action: "resolve", provider, member: holder });
      if (!resolved.ok) {
        if (resolved.error && /unavailable|no eligible|daemon/i.test(resolved.error)) {
          pi.notify?.(`OAR: ${resolved.error}`, "error");
        }
        return;
      }
      const nextProfile = resolved.data?.profile;
      if (last.provider === provider && last.profile && nextProfile && last.profile !== nextProfile) {
        pi.notify?.(`OAR auto-switch ${provider}: ${last.profile} → ${nextProfile}`, "info");
      }
      last.provider = provider;
      last.profile = nextProfile;
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
      const body = event?.body ?? event?.error ?? event?.message;
      let result = classifyStatus(event?.status, event?.headers, body);

      // Try daemon-mediated OAuth refresh before giving up / failing over.
      if (result === "AUTH_EXPIRED") {
        try {
          const refreshed = await request({
            protocol: 1,
            action: "refresh",
            provider: last.provider,
            profile: last.profile,
          });
          if (refreshed.ok) {
            pi.notify?.(
              `OAR refreshed ${last.provider}/${last.profile}${refreshed.data?.skipped ? " (fresh)" : ""}`,
              "info",
            );
            await request({
              protocol: 1,
              action: "report",
              provider: last.provider,
              account: last.profile,
              result: "SUCCESS",
              detail: "refresh_recovered",
            });
            return;
          }
        } catch {
          // fall through to report AUTH_EXPIRED → failover
        }
      }

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

      const reported = await request({
        protocol: 1,
        action: "report",
        provider: last.provider,
        account: last.profile,
        result,
        detail: typeof body === "string" ? body.slice(0, 240) : undefined,
      });
      const failover = reported?.data?.failover;
      if (failover?.to) {
        last.profile = failover.to;
        pi.notify?.(
          `OAR auto-failover ${last.provider}: ${failover.from} → ${failover.to} (${result})`,
          "warning",
        );
      } else if (result !== "SUCCESS") {
        if (process.env.OAR_DEBUG) {
          pi.notify?.(`OAR ${last.provider}/${last.profile}: ${result}`, "warning");
        }
      }
    } catch {
      // never break the agent loop
    }
  });

  pi.registerCommand("account", {
    description: "OAR account router (status|use|auto|doctor|bootstrap)",
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
        if (sub === "bootstrap") {
          const res = await request({ protocol: 1, action: "bootstrap-auto" });
          if (!res.ok) throw new Error(res.error);
          ctx.ui.notify(JSON.stringify(res.data, null, 2), "info");
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
        ctx.ui.notify("usage: /account status|bootstrap|use|auto|doctor", "warning");
      } catch (error) {
        ctx.ui.notify(
          `OAR: ${error instanceof Error ? error.message : String(error)}. Daemon auto-starts via LaunchAgent; check: oar doctor`,
          "error",
        );
      }
    },
  });
}
