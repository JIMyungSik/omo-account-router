// extensions/oar-model-presets.js
var ELIGIBLE_FALLBACK_RESULTS = new Set([
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "SERVER_ERROR"
]);
var MODEL_PRESETS = Object.freeze({
  "grok-astra": Object.freeze({
    source: "xai/grok-4.5",
    fallbacks: Object.freeze([
      "chatgpt-subscription/gpt-6-astra:high",
      "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:high"
    ]),
    revertPolicy: "cooldown-expiry"
  })
});
function presetByName(name) {
  const preset = MODEL_PRESETS[name];
  if (!preset)
    throw new Error(`Unknown model preset: ${name}`);
  return preset;
}
function splitSelector(selector) {
  const slash = selector.indexOf("/");
  return slash < 0 ? { provider: "", model: selector } : { provider: selector.slice(0, slash), model: selector.slice(slash + 1) };
}
function sameChain(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((entry, index) => entry === right[index]);
}
function getModelPresetStatus(name, settings) {
  const preset = presetByName(name);
  return {
    name,
    active: settings.modelFallback === true && sameChain(settings.chains?.[preset.source], preset.fallbacks),
    source: preset.source,
    fallbacks: [...preset.fallbacks],
    revertPolicy: preset.revertPolicy
  };
}
function runtimeStatus(preset, registry) {
  return [preset.source, ...preset.fallbacks].map((selector) => {
    const parsed = splitSelector(selector.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, ""));
    const model = registry?.find?.(parsed.provider, parsed.model);
    return {
      selector,
      modelFound: Boolean(model),
      configuredAuth: model ? registry?.hasConfiguredAuth?.(model) !== false : false,
      fallbackEligible: model ? registry?.isFallbackEligible?.(model) !== false : false
    };
  });
}
async function applyModelPreset(name, sessionSettings) {
  const preset = presetByName(name);
  await sessionSettings.setFallbackChain(preset.source, preset.fallbacks);
  await sessionSettings.setModelFallbackEnabled(true);
  await sessionSettings.setFallbackRevertPolicy(preset.revertPolicy);
}
async function disableModelPreset(name, sessionSettings) {
  const preset = presetByName(name);
  await sessionSettings.removeFallbackChain(preset.source);
}
function createModelPresetController() {
  let pendingRetry;
  let lastResult;
  return {
    noteProviderResult(observation) {
      const identity = {
        provider: observation.provider,
        model: observation.model
      };
      lastResult = observation.result === "SUCCESS" ? undefined : { ...identity, result: observation.result };
      pendingRetry = observation.failover?.to ? identity : undefined;
    },
    beforeRetryFallback(event, settings) {
      const preset = MODEL_PRESETS["grok-astra"];
      const source = splitSelector(preset.source);
      if (!getModelPresetStatus("grok-astra", settings).active || event.provider !== source.provider || event.model !== source.model) {
        return;
      }
      if (pendingRetry?.provider === event.provider && pendingRetry.model === event.model) {
        pendingRetry = undefined;
        lastResult = undefined;
        return { action: "retry-same-model" };
      }
      const result = lastResult?.provider === event.provider && lastResult.model === event.model ? lastResult.result : undefined;
      lastResult = undefined;
      if (result && ELIGIBLE_FALLBACK_RESULTS.has(result))
        return;
      if (!result && (event.reason === "billing" || event.reason === "transient")) {
        return;
      }
      return { action: "stop" };
    }
  };
}
function registerModelPresetCommand(pi) {
  pi.registerCommand("model-preset", {
    description: "Named model fallback presets (list|use|status|off)",
    handler: async (args, ctx) => {
      const [sub = "status", name = "grok-astra"] = String(args || "").trim().split(/\s+/).filter(Boolean);
      if (sub === "list") {
        ctx.ui.notify(JSON.stringify(Object.keys(MODEL_PRESETS)), "info");
        return;
      }
      if (sub === "use") {
        await applyModelPreset(name, ctx.sessionSettings);
        ctx.ui.notify(JSON.stringify({
          ...getModelPresetStatus(name, ctx.sessionSettings.getRetryFallbackSettings()),
          targets: runtimeStatus(presetByName(name), ctx.modelRegistry)
        }), "info");
        return;
      }
      if (sub === "off") {
        await disableModelPreset(name, ctx.sessionSettings);
        ctx.ui.notify(JSON.stringify({ name, active: false }), "info");
        return;
      }
      if (sub === "status") {
        ctx.ui.notify(JSON.stringify({
          ...getModelPresetStatus(name, ctx.sessionSettings.getRetryFallbackSettings()),
          targets: runtimeStatus(presetByName(name), ctx.modelRegistry)
        }), "info");
        return;
      }
      ctx.ui.notify("usage: /model-preset list|use|status|off [name]", "warning");
    }
  });
}

// extensions/oar-senpi-client.js
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
      if (idx === -1)
        return;
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
  for (let i = 0;i <= retries; i++) {
    try {
      return await requestOnce(body, 5000);
    } catch (error) {
      last = error;
      const msg = error instanceof Error ? error.message : String(error);
      const retryable = msg.includes("ENOENT") || msg.includes("ECONNREFUSED") || msg.includes("timeout");
      if (!retryable || i === retries)
        throw error;
      await sleep(50 * 2 ** i);
    }
  }
  throw last;
}
function headerText(headers) {
  if (!headers || typeof headers !== "object")
    return "";
  return Object.entries(headers).flatMap(([key, value]) => {
    if (value == null)
      return [];
    return [key, Array.isArray(value) ? value.join(" ") : String(value)];
  }).join(" ").toLowerCase();
}
function headerValue(headers, name) {
  if (!headers)
    return;
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle)
      return value;
  }
  return;
}
function classifyStatus(status, headers, body) {
  const text = `${String(body || "")} ${headerText(headers)}`.toLowerCase();
  if (status === 429)
    return "RATE_LIMITED";
  if (status === 401) {
    if (text.includes("invalid_grant") || text.includes("revok"))
      return "AUTH_REVOKED";
    return "AUTH_EXPIRED";
  }
  if (status === 402)
    return "QUOTA_EXHAUSTED";
  if (text.includes("invalid_grant") || text.includes("refresh token has been revoked") || text.includes("token has been revoked")) {
    return "AUTH_REVOKED";
  }
  if (status === 403 || text.includes("run out of credits") || text.includes("out of credits") || text.includes("need a grok subscription") || text.includes("insufficient_quota") || text.includes("usage limit")) {
    return "QUOTA_EXHAUSTED";
  }
  if (status >= 500)
    return "SERVER_ERROR";
  if (status === 400) {
    if (headerValue(headers, "retry-after"))
      return "RATE_LIMITED";
    if (text.includes("invalid_grant") || text.includes("invalid_token"))
      return "AUTH_REVOKED";
  }
  return null;
}
async function bootstrapAuto(pi) {
  try {
    const res = await request({ protocol: 1, action: "bootstrap-auto" });
    if (!res.ok) {
      if (process.env.OAR_DEBUG)
        pi.notify?.(`OAR bootstrap: ${res.error}`, "warning");
      return;
    }
    const enabled = res.data?.enabled || [];
    if (enabled.length && process.env.OAR_DEBUG) {
      const summary = enabled.map((entry) => `${entry.provider}(${entry.profiles})`).join(", ");
      pi.notify?.(`OAR auto-on: ${summary}`, "info");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (process.env.OAR_DEBUG)
      pi.notify?.(`OAR daemon offline (${msg})`, "warning");
  }
}

// extensions/oar-senpi.js
function createOarExtension({
  requestFn = request,
  bootstrapFn = bootstrapAuto
} = {}) {
  return (pi) => registerOarExtension(pi, { requestFn, bootstrapFn });
}
function registerOarExtension(pi, { requestFn, bootstrapFn }) {
  const holder = `omo:${process.pid}:${process.env.SENPI_TASK_ID || process.env.OMO_MEMBER || "session"}`;
  let last = { provider: null, model: null, profile: null, leaseId: null };
  const modelPreset = createModelPresetController();
  let bootstrapped = false;
  pi.on("session_start", async () => {
    bootstrapped = true;
    await bootstrapFn(pi);
  });
  pi.on("before_provider_request", async (event) => {
    if (!bootstrapped) {
      bootstrapped = true;
      await bootstrapFn(pi);
    }
    const provider = event?.model?.provider;
    if (!provider || provider === "cursor")
      return;
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
        holder
      });
      if (lease.ok)
        last.leaseId = lease.data?.id;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (process.env.OAR_DEBUG)
        pi.notify?.(`OAR resolve failed: ${msg}`, "warning");
    }
  });
  pi.on("after_provider_response", async (event) => {
    try {
      if (last.leaseId) {
        await requestFn({ protocol: 1, action: "release-lease", leaseId: last.leaseId });
        last.leaseId = null;
      }
      if (!last.provider || !last.profile)
        return;
      const body = event?.body ?? event?.error ?? event?.message;
      let result = classifyStatus(event?.status, event?.headers, body);
      if (result === "AUTH_EXPIRED") {
        try {
          const refreshed = await requestFn({
            protocol: 1,
            action: "refresh",
            provider: last.provider,
            profile: last.profile
          });
          if (refreshed.ok) {
            pi.notify?.(`OAR refreshed ${last.provider}/${last.profile}${refreshed.data?.skipped ? " (fresh)" : ""}`, "info");
            await requestFn({
              protocol: 1,
              action: "report",
              provider: last.provider,
              account: last.profile,
              result: "SUCCESS",
              detail: "refresh_recovered"
            });
            modelPreset.noteProviderResult({
              provider: last.provider,
              model: last.model,
              result: "SUCCESS"
            });
            return;
          }
        } catch {}
      }
      if (!result) {
        await requestFn({
          protocol: 1,
          action: "report",
          provider: last.provider,
          account: last.profile,
          result: "SUCCESS"
        });
        modelPreset.noteProviderResult({
          provider: last.provider,
          model: last.model,
          result: "SUCCESS"
        });
        return;
      }
      if (result === "SERVER_ERROR") {
        modelPreset.noteProviderResult({
          provider: last.provider,
          model: last.model,
          result
        });
        return;
      }
      const reported = await requestFn({
        protocol: 1,
        action: "report",
        provider: last.provider,
        account: last.profile,
        result,
        detail: typeof body === "string" ? body.slice(0, 240) : undefined
      });
      const failover = reported?.data?.failover;
      modelPreset.noteProviderResult({
        provider: last.provider,
        model: last.model,
        result,
        failover
      });
      if (failover?.to) {
        last.profile = failover.to;
        pi.notify?.(`OAR auto-failover ${last.provider}: ${failover.from} → ${failover.to} (${result})`, "warning");
      } else if (result !== "SUCCESS") {
        if (process.env.OAR_DEBUG) {
          pi.notify?.(`OAR ${last.provider}/${last.profile}: ${result}`, "warning");
        }
      }
    } catch {}
  });
  pi.on("before_retry_fallback", (event, ctx) => {
    const decision = modelPreset.beforeRetryFallback(event, ctx.sessionSettings.getRetryFallbackSettings());
    if (process.env.OAR_DEBUG) {
      ctx.ui.notify(`OAR preset ${event.provider}/${event.model} ${event.reason}: ${decision?.action || "continue"}`, "info");
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
          if (!res.ok)
            throw new Error(res.error);
          const lines = (res.data.accounts || []).map((a) => {
            const star = (res.data.resolvePreview || []).some((p) => p.provider === a.provider && p.profile === a.profile && p.status === "available") ? "★" : " ";
            return `${star} ${a.provider}/${a.profile} ${a.auth} ${a.availability}`;
          });
          ctx.ui.notify(lines.join(`
`) || "no accounts", "info");
          return;
        }
        if (sub === "bootstrap") {
          const res = await requestFn({ protocol: 1, action: "bootstrap-auto" });
          if (!res.ok)
            throw new Error(res.error);
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
          if (!res.ok)
            throw new Error(res.error);
          ctx.ui.notify(res.data.message || `using ${provider}/${profile}`, "info");
          return;
        }
        if (sub === "auto") {
          const provider = parts[1];
          const onoff = parts[2];
          if (!provider || onoff !== "on" && onoff !== "off") {
            ctx.ui.notify("usage: /account auto <provider> on|off", "warning");
            return;
          }
          const res = await requestFn({
            protocol: 1,
            action: "auto",
            provider,
            enabled: onoff === "on"
          });
          if (!res.ok)
            throw new Error(res.error);
          ctx.ui.notify(JSON.stringify(res.data), "info");
          return;
        }
        if (sub === "doctor") {
          const res = await requestFn({ protocol: 1, action: "doctor" });
          if (!res.ok)
            throw new Error(res.error);
          ctx.ui.notify(JSON.stringify(res.data, null, 2), "info");
          return;
        }
        ctx.ui.notify("usage: /account status|bootstrap|use|auto|doctor", "warning");
      } catch (error) {
        ctx.ui.notify(`OAR: ${error instanceof Error ? error.message : String(error)}. Daemon auto-starts via LaunchAgent; check: oar doctor`, "error");
      }
    }
  });
  registerModelPresetCommand(pi);
}
var oar_senpi_default = createOarExtension();

// extensions/oar-extension-entry.js
var oar_extension_entry_default = createOarExtension();
export {
  oar_extension_entry_default as default
};
