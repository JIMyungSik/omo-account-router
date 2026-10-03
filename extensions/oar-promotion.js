export const PROMOTION_ENTRY_TYPE = "oar-promotion";
const DEFAULT_REFRESH_MS = 30_000;
const MAX_TIMER_MS = 2_147_000_000;

export function latestPromotionRecord(entries) {
  let found;
  for (const entry of entries ?? []) {
    if (entry?.type === "custom" && entry.customType === PROMOTION_ENTRY_TYPE && entry.data) {
      found = entry.data;
    }
  }
  return found;
}

export function snapshotSessionModel(pi, ctx) {
  const model = ctx?.model ?? {};
  const thinking =
    typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : ctx?.thinkingLevel;
  return {
    provider: model.provider ?? null,
    id: model.id ?? null,
    thinking: thinking ?? null,
  };
}

export function isActivePromotionRecord(recorded) {
  return Boolean(recorded?.original?.provider && recorded.original.id && recorded.phase !== "restored");
}

function sameModel(left, right) {
  return Boolean(left?.provider && left?.id && left.provider === right?.provider && left.id === right?.id);
}

function parseNextBoundary(data) {
  const raw = data?.nextBoundary;
  if (!raw) return undefined;
  const at = typeof raw.at === "number" ? raw.at : Date.parse(raw.at);
  if (!Number.isFinite(at)) return undefined;
  return { at, entering: Boolean(raw.entering) };
}

export function createPromotionController({
  requestFn,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  refreshMs = DEFAULT_REFRESH_MS,
} = {}) {
  let applying = false;
  let disposed = false;
  let timer;
  let piRef;
  let ctxRef;
  let chain = Promise.resolve();
  let lastZeroAt;

  function persist(pi, data) {
    if (typeof pi.appendEntry !== "function") return;
    pi.appendEntry(PROMOTION_ENTRY_TYPE, {
      v: 1,
      ...data,
      at: new Date(now()).toISOString(),
    });
  }

  function clearTimer() {
    if (timer != null) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
  }

  function arm(nextBoundary) {
    clearTimer();
    if (disposed) return;
    const bound = Math.max(1, Number(refreshMs) || DEFAULT_REFRESH_MS);
    let delay = bound;
    if (nextBoundary?.at != null) {
      delay = Math.min(Math.max(nextBoundary.at - now(), 0), bound);
    }
    if (delay === 0) {
      const instant = now();
      if (lastZeroAt === instant) delay = bound;
      else lastZeroAt = instant;
    } else {
      lastZeroAt = undefined;
    }
    delay = Math.min(delay, MAX_TIMER_MS);
    timer = setTimeoutFn(() => {
      timer = undefined;
      if (piRef && ctxRef) return enqueue(piRef, ctxRef);
    }, delay);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  async function applyPromotional(pi, ctx, { original, promo }) {
    if (sameModel(snapshotSessionModel(pi, ctx), promo)) {
      if (latestPromotionRecord(ctx.sessionManager?.getEntries?.() ?? [])?.phase !== "applied") {
        persist(pi, { phase: "applied", original, promotional: promo });
      }
      return;
    }
    const model = ctx.modelRegistry?.find?.(promo.provider, promo.id);
    if (!model) {
      persist(pi, {
        phase: "apply_failed",
        original,
        promotional: promo,
        error: "model_not_found",
      });
      return;
    }
    applying = true;
    try {
      const ok = await pi.setModel(model);
      if (!ok) {
        persist(pi, {
          phase: "apply_failed",
          original,
          promotional: promo,
          error: "setModel_false",
        });
        return;
      }
      persist(pi, { phase: "applied", original, promotional: promo });
    } finally {
      applying = false;
    }
  }

  async function restoreOriginal(pi, ctx, { original, promotional }) {
    if (sameModel(snapshotSessionModel(pi, ctx), original)) {
      if (latestPromotionRecord(ctx.sessionManager?.getEntries?.() ?? [])?.phase !== "restored") {
        persist(pi, { phase: "restored", original, promotional });
      }
      return;
    }
    const model = ctx.modelRegistry?.find?.(original.provider, original.id);
    if (!model) {
      persist(pi, {
        phase: "restore_failed",
        original,
        promotional,
        error: "model_not_found",
      });
      return;
    }
    applying = true;
    try {
      const ok = await pi.setModel(model);
      if (!ok) {
        persist(pi, {
          phase: "restore_failed",
          original,
          promotional,
          error: "setModel_false",
        });
        return;
      }
      if (original.thinking != null && typeof pi.setThinkingLevel === "function") {
        pi.setThinkingLevel(original.thinking);
      }
      persist(pi, { phase: "restored", original, promotional });
    } finally {
      applying = false;
    }
  }

  async function doSync(pi, ctx) {
    if (disposed || !ctx || !requestFn) return;
    let status;
    try {
      status = await requestFn({ protocol: 1, action: "schedule-status" });
    } catch {
      arm(undefined);
      return;
    }
    if (disposed) return;
    const nextBoundary = parseNextBoundary(status?.data);
    if (!status?.ok) {
      arm(nextBoundary);
      return;
    }

    const data = status.data ?? {};
    const want = Boolean(data.enabled && data.inWindow);
    const promo = { provider: data.provider, id: data.model };
    const recorded = latestPromotionRecord(ctx.sessionManager?.getEntries?.() ?? []);
    const current = snapshotSessionModel(pi, ctx);

    if (want) {
      if (!promo.provider || !promo.id) {
        arm(nextBoundary);
        return;
      }
      const capturingFresh = !isActivePromotionRecord(recorded);
      const original = capturingFresh ? current : recorded.original;
      if (!original.provider || !original.id) {
        arm(nextBoundary);
        return;
      }
      if (capturingFresh) persist(pi, { phase: "captured", original, promotional: promo });
      await applyPromotional(pi, ctx, { original, promo });
      arm(nextBoundary);
      return;
    }

    if (!isActivePromotionRecord(recorded)) {
      arm(nextBoundary);
      return;
    }
    await restoreOriginal(pi, ctx, {
      original: recorded.original,
      promotional: recorded.promotional ?? promo,
    });
    arm(nextBoundary);
  }

  function enqueue(pi, ctx) {
    if (disposed) return Promise.resolve();
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
    sync(pi, ctx) {
      return enqueue(pi, ctx);
    },
    dispose() {
      disposed = true;
      clearTimer();
      piRef = undefined;
      ctxRef = undefined;
    },
    isApplying: () => applying,
  };
}
