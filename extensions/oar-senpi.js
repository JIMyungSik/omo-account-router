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
import {
  createModelPresetController,
  registerModelPresetCommand,
} from "./oar-model-presets.js";
import { createModelPinController } from "./oar-model-pin.js";
import { createPromotionController } from "./oar-promotion.js";
import { bootstrapAuto, classifyStatus, request } from "./oar-senpi-client.js";

export function createOarExtension({
  requestFn = request,
  bootstrapFn = bootstrapAuto,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  refreshMs,
} = {}) {
  return (pi) =>
    registerOarExtension(pi, { requestFn, bootstrapFn, now, setTimeoutFn, clearTimeoutFn, refreshMs });
}

function registerOarExtension(pi, { requestFn, bootstrapFn, now, setTimeoutFn, clearTimeoutFn, refreshMs }) {
  const holder = `omo:${process.pid}:${process.env.SENPI_TASK_ID || process.env.OMO_MEMBER || "session"}`;
  let last = { provider: null, model: null, profile: null, leaseId: null };
  const modelPreset = createModelPresetController();
  const promotion = createPromotionController({
    requestFn,
    now,
    setTimeoutFn,
    clearTimeoutFn,
    refreshMs,
  });
  const modelPin = createModelPinController({ requestFn, setTimeoutFn, clearTimeoutFn, refreshMs });
  let bootstrapped = false;

  // An explicit `oar model set` pin outranks the promotional window.
  async function syncModels(ctx) {
    if (await modelPin.sync(pi, ctx)) return;
    await promotion.sync(pi, ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    bootstrapped = true;
    await bootstrapFn(pi);
    await syncModels(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await syncModels(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    await syncModels(ctx);
  });

  // A pin that has to compact first only applies on an idle session, so retry the
  // moment the agent settles rather than waiting for the next timer tick.
  pi.on("agent_settled", async (_event, ctx) => {
    await syncModels(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await syncModels(ctx);
    } finally {
      modelPin.dispose();
      promotion.dispose();
    }
  });

  // Some hosts skip session_start for short tasks — still bootstrap once.
  pi.on("before_provider_request", async (event) => {
    if (!bootstrapped) {
      bootstrapped = true;
      await bootstrapFn(pi);
    }
    const provider = event?.model?.provider;
    if (!provider || provider === "cursor") return;
    last.model = event.model?.id || null;
    try {
      const resolved = await requestFn({ protocol: 1, action: "resolve", provider, member: holder });
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
      const lease = await requestFn({
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
        await requestFn({ protocol: 1, action: "release-lease", leaseId: last.leaseId });
        last.leaseId = null;
      }
      if (!last.provider || !last.profile) return;
      const body = event?.body ?? event?.error ?? event?.message;
      let result = classifyStatus(event?.status, event?.headers, body);

      // Try daemon-mediated OAuth refresh before giving up / failing over.
      if (result === "AUTH_EXPIRED") {
        try {
          const refreshed = await requestFn({
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
            await requestFn({
              protocol: 1,
              action: "report",
              provider: last.provider,
              account: last.profile,
              result: "SUCCESS",
              detail: "refresh_recovered",
            });
            modelPreset.noteProviderResult({
              provider: last.provider,
              model: last.model,
              result: "SUCCESS",
            });
            return;
          }
        } catch {
          // fall through to report AUTH_EXPIRED → failover
        }
      }

      if (!result) {
        await requestFn({
          protocol: 1,
          action: "report",
          provider: last.provider,
          account: last.profile,
          result: "SUCCESS",
        });
        modelPreset.noteProviderResult({
          provider: last.provider,
          model: last.model,
          result: "SUCCESS",
        });
        return;
      }
      if (result === "SERVER_ERROR") {
        modelPreset.noteProviderResult({
          provider: last.provider,
          model: last.model,
          result,
        });
        return;
      }

      const reported = await requestFn({
        protocol: 1,
        action: "report",
        provider: last.provider,
        account: last.profile,
        result,
        detail: typeof body === "string" ? body.slice(0, 240) : undefined,
      });
      const failover = reported?.data?.failover;
      modelPreset.noteProviderResult({
        provider: last.provider,
        model: last.model,
        result,
        failover,
      });
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

  pi.on("before_retry_fallback", (event, ctx) => {
    const decision = modelPreset.beforeRetryFallback(
      event,
      ctx.sessionSettings.getRetryFallbackSettings(),
    );
    if (process.env.OAR_DEBUG) {
      ctx.ui.notify(
        `OAR preset ${event.provider}/${event.model} ${event.reason}: ${decision?.action || "continue"}`,
        "info",
      );
    }
    return decision;
  });

  pi.registerCommand("account", {
    description: "OAR account router (status|use|auto|doctor|bootstrap)",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "status";
      try {
        if (sub === "status") {
          const res = await requestFn({ protocol: 1, action: "status" });
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
          const res = await requestFn({ protocol: 1, action: "bootstrap-auto" });
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
          const res = await requestFn({ protocol: 1, action: "use", provider, profile });
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
          const res = await requestFn({
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
          const res = await requestFn({ protocol: 1, action: "doctor" });
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

  registerModelPresetCommand(pi);
}

export default createOarExtension();
