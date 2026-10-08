export const MODEL_PIN_ENTRY_TYPE = "oar-model-pin";
const DEFAULT_REFRESH_MS = 30_000;

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
 */
export function createModelPinController({
  requestFn,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  refreshMs = DEFAULT_REFRESH_MS,
} = {}) {
  let disposed = false;
  let timer;
  let piRef;
  let ctxRef;
  let chain = Promise.resolve();
  let failedPinId;

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
      const ok = model ? await pi.setModel(model) : false;
      if (!ok) {
        failedPinId = pin.id;
        pi.notify?.(
          `OAR model pin: cannot switch to ${pin.provider}/${pin.model} (${model ? "setModel failed" : "model not found"})`,
          "warning",
        );
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
