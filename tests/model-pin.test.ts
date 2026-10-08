import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { OarDaemon } from "../src/daemon.ts";
import { OarStore } from "../src/store.ts";
import { parseModelSelector } from "../src/model-pin.ts";
import { createModelPinController, appliedPinId, MODEL_PIN_ENTRY_TYPE } from "../extensions/oar-model-pin.js";
import { createOarExtension } from "../extensions/oar-senpi.js";

function createSession(initial: { provider: string; id: string; thinking: string }, known = true) {
  const entries: Array<{ type: string; customType: string; data: Record<string, unknown> }> = [];
  let model = { provider: initial.provider, id: initial.id };
  let thinking = initial.thinking;
  const pi = {
    setModel: async (next: { provider: string; id: string }) => {
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
    notify: () => {},
  };
  const ctx = {
    get model() {
      return model;
    },
    modelRegistry: { find: (provider: string, id: string) => (known ? { provider, id } : undefined) },
    sessionManager: { getEntries: () => entries },
  };
  return { pi, ctx, entries };
}

const pinStatus = (over: Record<string, unknown> = {}) => ({
  ok: true,
  data: { active: true, id: "pin-1", provider: "opengateway", model: "deepseek/x", ...over },
});

describe("parseModelSelector", () => {
  test("splits at the first slash so model ids may contain slashes", () => {
    expect(parseModelSelector("opengateway/deepseek/x")).toEqual({ provider: "opengateway", model: "deepseek/x" });
    expect(() => parseModelSelector("grok-4.5")).toThrow();
    expect(() => parseModelSelector("xai/")).toThrow();
  });
});

describe("model pin controller", () => {
  test("applies a pin once per pin id and keeps later manual changes", async () => {
    const s = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    const ctl = createModelPinController({ requestFn: async () => pinStatus({ thinking: "low" }) });
    expect(await ctl.sync(s.pi, s.ctx)).toBe(true);
    expect(s.ctx.model).toEqual({ provider: "opengateway", id: "deepseek/x" });
    expect(s.pi.getThinkingLevel()).toBe("low");
    expect(appliedPinId(s.entries)).toBe("pin-1");

    await s.pi.setModel({ provider: "xai", id: "grok-4.5" });
    await ctl.sync(s.pi, s.ctx);
    expect(s.ctx.model).toEqual({ provider: "xai", id: "grok-4.5" });
    expect(s.entries.filter((e) => e.customType === MODEL_PIN_ENTRY_TYPE)).toHaveLength(1);

    const next = createModelPinController({ requestFn: async () => pinStatus({ id: "pin-2" }) });
    await next.sync(s.pi, s.ctx);
    expect(s.ctx.model).toEqual({ provider: "opengateway", id: "deepseek/x" });
  });

  test("inactive pin or daemon without the action changes nothing", async () => {
    const s = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    for (const res of [{ ok: true, data: { active: false } }, { ok: false, error: "unknown action" }]) {
      const ctl = createModelPinController({ requestFn: async () => res });
      expect(await ctl.sync(s.pi, s.ctx)).toBe(false);
    }
    expect(s.ctx.model).toEqual({ provider: "xai", id: "grok-4.5" });
    expect(s.entries).toHaveLength(0);
  });

  test("unknown model is not recorded as applied and is not retried", async () => {
    const s = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" }, false);
    let calls = 0;
    const ctl = createModelPinController({ requestFn: async () => (calls++, pinStatus()) });
    await ctl.sync(s.pi, s.ctx);
    await ctl.sync(s.pi, s.ctx);
    expect(s.ctx.model).toEqual({ provider: "xai", id: "grok-4.5" });
    expect(s.entries).toHaveLength(0);
  });

  test("extension prefers the pin over the promotional window", async () => {
    const s = createSession({ provider: "xai", id: "grok-4.5", thinking: "high" });
    const handlers: Record<string, (e: unknown, c: unknown) => Promise<void>> = {};
    const pi = { ...s.pi, on: (name: string, fn: never) => (handlers[name] = fn), registerCommand: () => {} };
    createOarExtension({
      requestFn: async (req: { action: string }) =>
        req.action === "model-pin-status"
          ? pinStatus()
          : { ok: true, data: { enabled: true, inWindow: true, provider: "other", model: "promo" } },
      bootstrapFn: async () => {},
    })(pi);
    await handlers.turn_start!({}, s.ctx);
    expect(s.ctx.model).toEqual({ provider: "opengateway", id: "deepseek/x" });
  });
});

describe("oar model CLI", () => {
  let root: string;
  let daemon: OarDaemon;
  const prevHome = process.env.OAR_HOME;
  const prevSock = process.env.OAR_SOCK;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oar-model-pin-"));
    process.env.OAR_HOME = root;
    process.env.OAR_SOCK = join(root, "oar.sock");
    daemon = new OarDaemon({
      store: new OarStore({ rootDir: root }),
      socketPath: process.env.OAR_SOCK,
      activateOnUse: false,
    });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    if (prevHome === undefined) delete process.env.OAR_HOME;
    else process.env.OAR_HOME = prevHome;
    if (prevSock === undefined) delete process.env.OAR_SOCK;
    else process.env.OAR_SOCK = prevSock;
    rmSync(root, { recursive: true, force: true });
  });

  async function json(args: string[]) {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      await runCli(args);
    } finally {
      console.log = orig;
    }
    return JSON.parse(logs.join("\n"));
  }

  test("set, status, clear round-trip through the daemon", async () => {
    expect((await json(["model", "status", "--json"])).active).toBe(false);
    const set = await json(["model", "set", "opengateway/deepseek/x", "--thinking", "low", "--json"]);
    expect(set).toMatchObject({ active: true, provider: "opengateway", model: "deepseek/x", thinking: "low" });
    const again = await json(["model", "set", "xai/grok-4.5", "--json"]);
    expect(again.id).not.toBe(set.id);
    expect(await json(["model", "status", "--json"])).toMatchObject({ provider: "xai", model: "grok-4.5" });
    await runCli(["model", "clear"]);
    expect((await json(["model", "status", "--json"])).active).toBe(false);
  });

  test("rejects a selector without a provider", async () => {
    await expect(runCli(["model", "set", "grok-4.5"])).rejects.toThrow(/provider/);
  });
});
