const ELIGIBLE_FALLBACK_RESULTS = new Set([
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "SERVER_ERROR",
]);

export const MODEL_PRESETS = Object.freeze({
  "grok-astra": Object.freeze({
    source: "xai/grok-4.5",
    fallbacks: Object.freeze([
      "chatgpt-subscription/gpt-6-astra:high",
      "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:high",
    ]),
    revertPolicy: "cooldown-expiry",
  }),
});

function presetByName(name) {
  const preset = MODEL_PRESETS[name];
  if (!preset) throw new Error(`Unknown model preset: ${name}`);
  return preset;
}

function splitSelector(selector) {
  const slash = selector.indexOf("/");
  return slash < 0
    ? { provider: "", model: selector }
    : { provider: selector.slice(0, slash), model: selector.slice(slash + 1) };
}

function sameChain(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

export function getModelPresetStatus(name, settings) {
  const preset = presetByName(name);
  return {
    name,
    active:
      settings.modelFallback === true &&
      sameChain(settings.chains?.[preset.source], preset.fallbacks),
    source: preset.source,
    fallbacks: [...preset.fallbacks],
    revertPolicy: preset.revertPolicy,
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
      fallbackEligible: model ? registry?.isFallbackEligible?.(model) !== false : false,
    };
  });
}

export async function applyModelPreset(name, sessionSettings) {
  const preset = presetByName(name);
  await sessionSettings.setFallbackChain(preset.source, preset.fallbacks);
  await sessionSettings.setModelFallbackEnabled(true);
  await sessionSettings.setFallbackRevertPolicy(preset.revertPolicy);
}

export async function disableModelPreset(name, sessionSettings) {
  const preset = presetByName(name);
  await sessionSettings.removeFallbackChain(preset.source);
}

export function createModelPresetController() {
  let pendingRetry;
  let lastResult;

  return {
    noteProviderResult(observation) {
      const identity = {
        provider: observation.provider,
        model: observation.model,
      };
      lastResult =
        observation.result === "SUCCESS"
          ? undefined
          : { ...identity, result: observation.result };
      pendingRetry = observation.failover?.to ? identity : undefined;
    },

    beforeRetryFallback(event, settings) {
      const preset = MODEL_PRESETS["grok-astra"];
      const source = splitSelector(preset.source);
      if (
        !getModelPresetStatus("grok-astra", settings).active ||
        event.provider !== source.provider ||
        event.model !== source.model
      ) {
        return undefined;
      }
      if (
        pendingRetry?.provider === event.provider &&
        pendingRetry.model === event.model
      ) {
        pendingRetry = undefined;
        lastResult = undefined;
        return { action: "retry-same-model" };
      }

      const result =
        lastResult?.provider === event.provider && lastResult.model === event.model
          ? lastResult.result
          : undefined;
      lastResult = undefined;
      if (result && ELIGIBLE_FALLBACK_RESULTS.has(result)) return undefined;
      if (!result && (event.reason === "billing" || event.reason === "transient")) {
        return undefined;
      }
      return { action: "stop" };
    },
  };
}

export function registerModelPresetCommand(pi) {
  pi.registerCommand("model-preset", {
    description: "Named model fallback presets (list|use|status|off)",
    handler: async (args, ctx) => {
      const [sub = "status", name = "grok-astra"] = String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (sub === "list") {
        ctx.ui.notify(JSON.stringify(Object.keys(MODEL_PRESETS)), "info");
        return;
      }
      if (sub === "use") {
        await applyModelPreset(name, ctx.sessionSettings);
        ctx.ui.notify(JSON.stringify({
          ...getModelPresetStatus(name, ctx.sessionSettings.getRetryFallbackSettings()),
          targets: runtimeStatus(presetByName(name), ctx.modelRegistry),
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
          targets: runtimeStatus(presetByName(name), ctx.modelRegistry),
        }), "info");
        return;
      }
      ctx.ui.notify("usage: /model-preset list|use|status|off [name]", "warning");
    },
  });
}
