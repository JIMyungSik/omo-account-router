import { describe, expect, test } from "bun:test";
import { createOarExtension } from "../extensions/oar-senpi.js";
import {
  createPromotionController,
  isActivePromotionRecord,
  latestPromotionRecord,
  PROMOTION_ENTRY_TYPE,
} from "../extensions/oar-promotion.js";

const PROMO = {
  provider: "opengateway",
  id: "deepseek/deepseek-v4.1-flash-ultrafast",
};

type Timer = { id: number; fn: () => void; ms: number };

function createSession(initial: { provider: string; id: string; thinking: string }) {
  const entries: Array<{ type: string; customType: string; data: Record<string, unknown> }> = [];
  let model = { provider: initial.provider, id: initial.id };
  let thinking = initial.thinking;
  let setModelOk = true;
  const pi = {
    setModel: async (next: { provider: string; id: string }) => {
      if (!setModelOk) return false;
      model = { provider: next.provider, id: next.id };
      return true;
    },
    setThinkingLevel: (level: string) => {
      thinking = level;
    },
    getThinkingLevel: () => thinking,
    appendEntry: (customType: string, data: Record<string, unknown>) => {
      entries.push({ type: "custom", customType, data });
    },
    failSetModel() {
      setModelOk = false;
    },
    succeedSetModel() {
      setModelOk = true;
    },
  };
  const ctx = {
    get model() {
      return model;
    },
    get thinkingLevel() {
      return thinking;
    },
    modelRegistry: {
      find(provider: string, id: string) {
        return { provider, id };
      },
    },
    sessionManager: {
      getEntries: () => entries,
    },
  };
  return { pi, ctx, entries };
}

function status(
  inWindow: boolean,
  enabled = true,
  nextBoundary?: { at: string; entering: boolean },
) {
  return {
    ok: true,
    data: {
      enabled,
      inWindow: enabled && inWindow,
      provider: PROMO.provider,
      model: PROMO.id,
      ...(nextBoundary ? { nextBoundary } : {}),
    },
  };
}

function createTimers() {
  const timers: Timer[] = [];
  let seq = 0;
  return {
    timers,
    setTimeoutFn(fn: () => void, ms?: number) {
      seq += 1;
      const timer = { id: seq, fn, ms: ms ?? 0 };
      timers.push(timer);
      return timer.id;
    },
    clearTimeoutFn(id: number) {
      const idx = timers.findIndex((timer) => timer.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    },
    async fireFirst() {
      // Fake clock: the earliest-due timer fires first (the model pin poller also arms one).
      const due = timers.reduce((min, t) => (t.ms < min.ms ? t : min), timers[0]!);
      const timer = due && timers.splice(timers.indexOf(due), 1)[0];
      if (!timer) throw new Error("no timer");
      await timer.fn();
      return timer;
    },
  };
}

const ASTRA = { provider: "chatgpt-subscription", id: "gpt-6-astra" };
const GROK = { provider: "xai", id: "grok-4.5" };

describe("promotional session override", () => {
  test("switches at the window boundary it witnesses and restores at the end", async () => {
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    let inWindow = false;
    const controller = createPromotionController({
      requestFn: async () => status(inWindow),
    });
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(GROK);

    inWindow = true;
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(PROMO);
    expect(latestPromotionRecord(session.entries)?.phase).toBe("applied");
    expect(latestPromotionRecord(session.entries)?.original).toEqual({
      provider: "xai",
      id: "grok-4.5",
      thinking: "high",
    });

    inWindow = false;
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(GROK);
    expect(session.pi.getThinkingLevel()).toBe("high");
    expect(latestPromotionRecord(session.entries)?.phase).toBe("restored");
    expect(isActivePromotionRecord(latestPromotionRecord(session.entries))).toBe(false);
  });

  test("a session started inside the window is never switched", async () => {
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    const controller = createPromotionController({ requestFn: async () => status(true) });
    for (let i = 0; i < 3; i += 1) await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(GROK);
    expect(session.entries).toHaveLength(0);
  });

  test("disable restores the original model", async () => {
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "medium" });
    let enabled = false;
    const controller = createPromotionController({
      requestFn: async () => status(true, enabled),
    });
    await controller.sync(session.pi, session.ctx);
    enabled = true;
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(PROMO);
    enabled = false;
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(GROK);
    expect(session.pi.getThinkingLevel()).toBe("medium");
  });

  test("resume uses persisted original instead of the restored promotional model", async () => {
    const parent = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    let inWindow = false;
    const apply = createPromotionController({ requestFn: async () => status(inWindow) });
    await apply.sync(parent.pi, parent.ctx);
    inWindow = true;
    await apply.sync(parent.pi, parent.ctx);
    expect(parent.ctx.model).toEqual(PROMO);

    const resumed = createSession({
      provider: PROMO.provider,
      id: PROMO.id,
      thinking: "off",
    });
    resumed.entries.push(...parent.entries);
    const restore = createPromotionController({ requestFn: async () => status(false) });
    await restore.sync(resumed.pi, resumed.ctx);
    expect(resumed.ctx.model).toEqual(GROK);
    expect(resumed.pi.getThinkingLevel()).toBe("high");
  });

  test("child sessions keep their own original model and thinking", async () => {
    let inWindow = false;
    const requestFn = async () => status(inWindow);
    const parent = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    const child = createSession({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      thinking: "low",
    });
    const parentCtl = createPromotionController({ requestFn });
    const childCtl = createPromotionController({ requestFn });
    await parentCtl.sync(parent.pi, parent.ctx);
    await childCtl.sync(child.pi, child.ctx);

    inWindow = true;
    await parentCtl.sync(parent.pi, parent.ctx);
    await childCtl.sync(child.pi, child.ctx);
    expect(parent.ctx.model).toEqual(PROMO);
    expect(child.ctx.model).toEqual(PROMO);

    inWindow = false;
    await parentCtl.sync(parent.pi, parent.ctx);
    await childCtl.sync(child.pi, child.ctx);
    expect(parent.ctx.model).toEqual(GROK);
    expect(parent.pi.getThinkingLevel()).toBe("high");
    expect(child.ctx.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(child.pi.getThinkingLevel()).toBe("low");
  });

  test("setModel failure cannot erase the original model", async () => {
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    let inWindow = false;
    const controller = createPromotionController({ requestFn: async () => status(inWindow) });
    await controller.sync(session.pi, session.ctx);
    session.pi.failSetModel();
    inWindow = true;
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(GROK);
    expect(session.pi.getThinkingLevel()).toBe("high");
    expect(latestPromotionRecord(session.entries)?.phase).toBe("apply_failed");
    expect(latestPromotionRecord(session.entries)?.original).toEqual({
      provider: "xai",
      id: "grok-4.5",
      thinking: "high",
    });
  });

  test("idle boundary timer applies and restores without a user prompt", async () => {
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    let nowMs = 1_000;
    let inWindow = false;
    const clock = createTimers();
    const controller = createPromotionController({
      now: () => nowMs,
      requestFn: async () =>
        status(inWindow, true, { at: new Date(inWindow ? 3_000 : 2_000).toISOString(), entering: !inWindow }),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      refreshMs: 60_000,
    });

    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(GROK);
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0]?.ms).toBe(1_000);

    nowMs = 2_000;
    inWindow = true;
    await clock.fireFirst();
    expect(session.ctx.model).toEqual(PROMO);
    expect(latestPromotionRecord(session.entries)?.phase).toBe("applied");

    nowMs = 3_000;
    inWindow = false;
    await clock.fireFirst();
    expect(session.ctx.model).toEqual(GROK);
    expect(latestPromotionRecord(session.entries)?.phase).toBe("restored");
    controller.dispose();
    expect(clock.timers).toHaveLength(0);
  });

  test("after restore a later manual model is kept and recaptured on the next window", async () => {
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    let inWindow = false;
    const controller = createPromotionController({
      requestFn: async () => status(inWindow),
    });
    await controller.sync(session.pi, session.ctx);
    inWindow = true;
    await controller.sync(session.pi, session.ctx);
    inWindow = false;
    await controller.sync(session.pi, session.ctx);
    expect(latestPromotionRecord(session.entries)?.phase).toBe("restored");

    await session.pi.setModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
    session.pi.setThinkingLevel("low");
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(session.pi.getThinkingLevel()).toBe("low");
    expect(latestPromotionRecord(session.entries)?.phase).toBe("restored");
    expect(latestPromotionRecord(session.entries)?.original).toEqual({
      provider: "xai",
      id: "grok-4.5",
      thinking: "high",
    });

    inWindow = true;
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(PROMO);
    expect(latestPromotionRecord(session.entries)?.phase).toBe("applied");
    expect(latestPromotionRecord(session.entries)?.original).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      thinking: "low",
    });
  });

  test("a manual model picked after the switch is never forced back", async () => {
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    let inWindow = false;
    const controller = createPromotionController({ requestFn: async () => status(inWindow) });
    await controller.sync(session.pi, session.ctx);
    inWindow = true;
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(PROMO);

    await session.pi.setModel(ASTRA);
    for (let i = 0; i < 3; i += 1) await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(ASTRA);
    expect(latestPromotionRecord(session.entries)?.phase).toBe("applied");
  });

  test("a new promotional model replaces live sessions once, then leaves them alone", async () => {
    const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5" };
    let promo = PROMO;
    const requestFn = async () => ({
      ok: true,
      data: { enabled: true, inWindow: true, provider: promo.provider, model: promo.id },
    });
    const a = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    const b = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    const aCtl = createPromotionController({ requestFn });
    const bCtl = createPromotionController({ requestFn });
    await aCtl.sync(a.pi, a.ctx);
    await bCtl.sync(b.pi, b.ctx);
    expect(a.ctx.model).toEqual(GROK);

    promo = sonnet;
    await aCtl.sync(a.pi, a.ctx);
    await bCtl.sync(b.pi, b.ctx);
    expect(a.ctx.model).toEqual(sonnet);
    expect(b.ctx.model).toEqual(sonnet);

    await a.pi.setModel(ASTRA);
    await aCtl.sync(a.pi, a.ctx);
    await aCtl.sync(a.pi, a.ctx);
    expect(a.ctx.model).toEqual(ASTRA);
    expect(b.ctx.model).toEqual(sonnet);
  });

  test("window exit does not restore over a manual pick, and the next window recaptures it", async () => {
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    let inWindow = false;
    const controller = createPromotionController({ requestFn: async () => status(inWindow) });
    await controller.sync(session.pi, session.ctx);
    inWindow = true;
    await controller.sync(session.pi, session.ctx);
    await session.pi.setModel(ASTRA);
    session.pi.setThinkingLevel("low");

    inWindow = false;
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(ASTRA);
    expect(session.pi.getThinkingLevel()).toBe("low");
    expect(latestPromotionRecord(session.entries)?.phase).toBe("restored");

    inWindow = true;
    await controller.sync(session.pi, session.ctx);
    expect(session.ctx.model).toEqual(PROMO);
    expect(latestPromotionRecord(session.entries)?.original).toMatchObject(ASTRA);
  });

  test("serializes concurrent sync so the first capture wins", async () => {
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const controller = createPromotionController({
      requestFn: async () => {
        calls += 1;
        if (calls === 1) await firstGate;
        return status(calls > 1);
      },
    });
    const first = controller.sync(session.pi, session.ctx);
    const second = controller.sync(session.pi, session.ctx);
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(session.entries.filter((entry) => entry.data.phase === "captured")).toHaveLength(1);
    expect(latestPromotionRecord(session.entries)?.original).toEqual({
      provider: "xai",
      id: "grok-4.5",
      thinking: "high",
    });
  });

  test("wires session hooks, turn reevaluation, idle timer, and dispose", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const session = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    let nowMs = 1_000;
    let inWindow = false;
    const clock = createTimers();
    createOarExtension({
      now: () => nowMs,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      refreshMs: 60_000,
      requestFn: async (body: { action?: string }) => {
        if (body.action === "schedule-status") {
          return status(inWindow, true, {
            at: new Date(inWindow ? 3_000 : 2_000).toISOString(),
            entering: !inWindow,
          });
        }
        if (body.action === "bootstrap-auto") return { ok: true, data: { enabled: [] } };
        throw new Error(`Unexpected action: ${String(body.action)}`);
      },
      bootstrapFn: async () => {},
    })({
      on(name: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(name, handler);
      },
      registerCommand() {},
      notify() {},
      setModel: session.pi.setModel,
      setThinkingLevel: session.pi.setThinkingLevel,
      getThinkingLevel: session.pi.getThinkingLevel,
      appendEntry: session.pi.appendEntry,
    });

    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("turn_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    expect(handlers.has("before_provider_request")).toBe(true);

    await handlers.get("session_start")?.({}, session.ctx);
    expect(session.ctx.model).toEqual(GROK);

    inWindow = true;
    await handlers.get("turn_start")?.({}, session.ctx);
    expect(session.ctx.model).toEqual(PROMO);
    expect(session.entries.some((entry) => entry.customType === PROMOTION_ENTRY_TYPE)).toBe(true);

    inWindow = false;
    await handlers.get("before_provider_request")?.({ model: { provider: PROMO.provider, id: PROMO.id } });
    expect(session.ctx.model).toEqual(PROMO);

    await handlers.get("turn_start")?.({}, session.ctx);
    expect(session.ctx.model).toEqual(GROK);

    inWindow = true;
    nowMs = 2_000;
    await clock.fireFirst();
    expect(session.ctx.model).toEqual(PROMO);

    inWindow = false;
    await handlers.get("before_agent_start")?.({}, session.ctx);
    expect(session.ctx.model).toEqual(GROK);

    await handlers.get("session_shutdown")?.({}, session.ctx);
    expect(clock.timers).toHaveLength(0);
  });
});
