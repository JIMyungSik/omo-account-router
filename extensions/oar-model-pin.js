export const MODEL_PIN_ENTRY_TYPE = "oar-model-pin";
const DEFAULT_REFRESH_MS = 30_000;
const DEFAULT_COMPACT_MIN_TOKENS = 20_000;
const DEFAULT_COMPACT_TIMEOUT_MS = 120_000;
const COMPACT_INSTRUCTIONS =
  "Summarize the whole session before a model switch. Keep the goal, constraints, decisions, changed files and next steps.";

function envFlagOn(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text !== "0" && text !== "false" && text !== "off" && text !== "no";
}

function envNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

/**
 * Switching onto a smaller-context model fails while a session still carries its
 * full context, so the pin compacts once before the switch. Tune with
 * OAR_MODEL_PIN_PRECOMPACT=0 / _MIN_TOKENS / _TIMEOUT_MS.
 */
export function precompactSettings(env = process.env) {
  return {
    enabled: envFlagOn(env?.OAR_MODEL_PIN_PRECOMPACT ?? "1"),
    minTokens: envNumber(env?.OAR_MODEL_PIN_PRECOMPACT_MIN_TOKENS, DEFAULT_COMPACT_MIN_TOKENS),
    timeoutMs: envNumber(env?.OAR_MODEL_PIN_PRECOMPACT_TIMEOUT_MS, DEFAULT_COMPACT_TIMEOUT_MS),
  };
}

/**
 * ctx.compact() never awaits completion, so bridge its callbacks to a promise.
 * A host that never answers must not wedge the pin, so give up after timeoutMs.
 */
export function waitForCompact(ctx, { timeoutMs, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeoutFn(timer);
      resolve(result);
    }
    timer = setTimeoutFn(() => finish({ status: "timeout" }), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    if (settled) clearTimeoutFn(timer);
    try {
      ctx.compact({
        customInstructions: COMPACT_INSTRUCTIONS,
        onComplete: () => finish({ status: "compacted" }),
        onError: (error) => finish({ status: "failed", errorMessage: error?.message ?? String(error) }),
      });
    } catch (error) {
      finish({ status: "failed", errorMessage: error?.message ?? String(error) });
    }
  });
}

export async function precompactBeforeSwitch({ pi, ctx, settings = precompactSettings(), notify } = {}) {
  const say = notify ?? ((text, level) => notifyUi(ctx, pi, text, level));
  if (!settings.enabled) return { status: "disabled" };
  if (typeof ctx?.compact !== "function") return { status: "unsupported" };
  const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  const tokens = usage?.tokens;
  if (typeof tokens === "number" && tokens < settings.minTokens) return { status: "skipped-small", tokens };
  const result = await waitForCompact(ctx, settings);
  if (result.status === "failed") {
    say(`OAR model pin: pre-switch compaction failed (${result.errorMessage}); switching anyway`, "warning");
  } else if (result.status === "timeout") {
    say("OAR model pin: pre-switch compaction timed out; switching anyway", "warning");
  }
  return result;
}

function notifyUi(ctx, pi, text, level) {
  if (typeof ctx?.ui?.notify === "function") {
    ctx.ui.notify(text, level);
    return;
  }
  if (typeof pi?.notify === "function") pi.notify(text, level);
}

/**
 * A busy session cannot be compacted, so the pin waits for the next idle tick
 * instead of forcing a switch mid-run.
 */
function isBusy(ctx) {
  if (typeof ctx?.isIdle === "function") return ctx.isIdle() === false;
  return ctx?.signal != null;
}

export function appliedPinId(entries) {
  let found;
  for (const entry of entries ?? []) {
    if (entry?.type === "custom" && entry.customType === MODEL_PIN_ENTRY_TYPE && entry.data?.pinId) {
      found = entry.data.pinId;
    }
  }
  return found;
}

/**
 * `oar model set` pins one model for every OMO session. Each session applies a
 * given pin id once (persisted in the session), so later manual /model changes
 * stick until the next `oar model set`. Sessions started after the pin pick it
 * up too, until `oar model clear`.
 *
 * Before the switch the session is compacted once, so a big context cannot stop
 * the new model from taking effect.
 */
export function createModelPinController({
  requestFn,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  refreshMs = DEFAULT_REFRESH_MS,
  env = process.env,
  precompact,
} = {}) {
  let disposed = false;
  let timer;
  let piRef;
  let ctxRef;
  let chain = Promise.resolve();
  let failedPinId;
  const settings = precompactSettings(env);
  const compactFn = precompact ?? ((args) => precompactBeforeSwitch({ ...args, settings, setTimeoutFn, clearTimeoutFn }));

  function arm() {
    if (timer != null) clearTimeoutFn(timer);
    timer = undefined;
    if (disposed) return;
    timer = setTimeoutFn(() => {
      timer = undefined;
      if (piRef && ctxRef) return enqueue(piRef, ctxRef);
    }, Math.max(1, Number(refreshMs) || DEFAULT_REFRESH_MS));
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  async function doSync(pi, ctx) {
    if (disposed || !ctx || !requestFn) return false;
    let res;
    try {
      res = await requestFn({ protocol: 1, action: "model-pin-status" });
    } catch {
      return false;
    } finally {
      arm();
    }
    const pin = res?.ok ? res.data : undefined;
    if (disposed || pin?.active !== true || !pin.id || !pin.provider || !pin.model) return false;
    if (appliedPinId(ctx.sessionManager?.getEntries?.() ?? []) === pin.id) return true;
    if (failedPinId === pin.id) return true;

    const current = ctx.model;
    const alreadyThere = current?.provider === pin.provider && current?.id === pin.model;
    if (!alreadyThere) {
      const model = ctx.modelRegistry?.find?.(pin.provider, pin.model);
      if (!model) {
        failedPinId = pin.id;
        notifyUi(ctx, pi, `OAR model pin: cannot switch to ${pin.provider}/${pin.model} (model not found)`, "warning");
        return true;
      }
      // Pending, not failed: compaction needs an idle session, so retry on the next timer tick.
      if (isBusy(ctx)) return true;
      await compactFn({ pi, ctx });
      const ok = await pi.setModel(model);
      if (!ok) {
        failedPinId = pin.id;
        notifyUi(ctx, pi, `OAR model pin: cannot switch to ${pin.provider}/${pin.model} (setModel failed)`, "warning");
        return true;
      }
    }
    if (pin.thinking && typeof pi.setThinkingLevel === "function") pi.setThinkingLevel(pin.thinking);
    if (typeof pi.appendEntry === "function") pi.appendEntry(MODEL_PIN_ENTRY_TYPE, { v: 1, pinId: pin.id });
    return true;
  }

  function enqueue(pi, ctx) {
    if (disposed) return Promise.resolve(false);
    piRef = pi;
    ctxRef = ctx;
    const run = () => doSync(pi, ctx);
    const next = chain.then(run, run);
    chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  return {
    /** Resolves true while a pin is active, so callers can skip competing model overrides. */
    sync: enqueue,
    dispose() {
      disposed = true;
      if (timer != null) clearTimeoutFn(timer);
      timer = undefined;
      piRef = undefined;
      ctxRef = undefined;
    },
  };
}
