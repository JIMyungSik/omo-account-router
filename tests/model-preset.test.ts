import { describe, expect, test } from "bun:test";
import {
  applyModelPreset,
  createModelPresetController,
  disableModelPreset,
  getModelPresetStatus,
  MODEL_PRESETS,
  registerModelPresetCommand,
} from "../extensions/oar-model-presets.js";
import { createOarExtension } from "../extensions/oar-senpi.js";

const sourceEvent = {
  type: "before_retry_fallback",
  provider: "xai",
  model: "grok-4.5",
  reason: "billing",
} as const;

function fallbackSettings() {
  return {
    modelFallback: true,
    chains: {
      [MODEL_PRESETS["grok-astra"].source]: [...MODEL_PRESETS["grok-astra"].fallbacks],
    },
    revertPolicy: "cooldown-expiry",
  };
}

describe("Grok to Astra model preset", () => {
  test("retries the same Grok model after OAR switches accounts", () => {
    const controller = createModelPresetController();
    controller.noteProviderResult({
      provider: "xai",
      model: "grok-4.5",
      result: "QUOTA_EXHAUSTED",
      failover: { from: "main", to: "sub" },
    });

    const firstDecision = controller.beforeRetryFallback(sourceEvent, fallbackSettings());
    const consumedDecision = controller.beforeRetryFallback(sourceEvent, fallbackSettings());

    expect(firstDecision).toEqual({ action: "retry-same-model" });
    expect(consumedDecision).toBeUndefined();
  });

  test("allows native Astra fallback only after eligible account exhaustion", () => {
    const controller = createModelPresetController();
    controller.noteProviderResult({
      provider: "xai",
      model: "grok-4.5",
      result: "QUOTA_EXHAUSTED",
    });

    expect(controller.beforeRetryFallback(sourceEvent, fallbackSettings())).toBeUndefined();
  });

  test.each([
    ["AUTH_EXPIRED", "hard-error"],
    ["AUTH_REVOKED", "hard-error"],
    ["BAD_REQUEST", "hard-error"],
    ["INVALID_ARGUMENT", "hard-error"],
    ["MODEL_NOT_FOUND", "hard-error"],
    ["PROMPT_ERROR", "refusal"],
    ["TOOL_ERROR", "hard-error"],
    ["LOCAL_ERROR", "hard-error"],
    ["UNKNOWN", "hard-error"],
  ] as const)("stops model fallback for %s", (result, reason) => {
    const controller = createModelPresetController();
    controller.noteProviderResult({
      provider: "xai",
      model: "grok-4.5",
      result,
    });

    expect(
      controller.beforeRetryFallback(
        { ...sourceEvent, reason },
        fallbackSettings(),
      ),
    ).toEqual({ action: "stop" });
  });

  test("stops refusal without a provider failure classification", () => {
    const controller = createModelPresetController();

    expect(
      controller.beforeRetryFallback(
        { ...sourceEvent, reason: "refusal" },
        fallbackSettings(),
      ),
    ).toEqual({ action: "stop" });
  });

  test("keeps account retry state isolated by extension instance", () => {
    const first = createModelPresetController();
    const second = createModelPresetController();
    first.noteProviderResult({
      provider: "xai",
      model: "grok-4.5",
      result: "RATE_LIMITED",
      failover: { from: "main", to: "sub" },
    });

    expect(first.beforeRetryFallback(sourceEvent, fallbackSettings())).toEqual({
      action: "retry-same-model",
    });
    expect(second.beforeRetryFallback(sourceEvent, fallbackSettings())).toBeUndefined();
  });

  test("applies and disables the exact native fallback chain", async () => {
    const calls: Array<readonly unknown[]> = [];
    const sessionSettings = {
      getRetryFallbackSettings: fallbackSettings,
      setFallbackChain: async (source: string, fallbacks: readonly string[]) => {
        calls.push(["chain", source, [...fallbacks]]);
      },
      removeFallbackChain: async (source: string) => {
        calls.push(["remove", source]);
      },
      setModelFallbackEnabled: async (enabled: boolean) => {
        calls.push(["enabled", enabled]);
      },
      setFallbackRevertPolicy: async (policy: string) => {
        calls.push(["policy", policy]);
      },
    };

    await applyModelPreset("grok-astra", sessionSettings);
    await disableModelPreset("grok-astra", sessionSettings);

    expect(calls).toEqual([
      ["chain", "xai/grok-4.5", [
        "chatgpt-subscription/gpt-6-astra:high",
        "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:high",
      ]],
      ["enabled", true],
      ["policy", "cooldown-expiry"],
      ["remove", "xai/grok-4.5"],
    ]);
  });

  test("reports active status only for the exact preset chain", () => {
    expect(getModelPresetStatus("grok-astra", fallbackSettings())).toEqual({
      name: "grok-astra",
      active: true,
      source: "xai/grok-4.5",
      fallbacks: [
        "chatgpt-subscription/gpt-6-astra:high",
        "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash:high",
      ],
      revertPolicy: "cooldown-expiry",
    });
    expect(
      getModelPresetStatus("grok-astra", {
        ...fallbackSettings(),
        chains: { "xai/grok-4.5": ["chatgpt-subscription/gpt-6-astra:high"] },
      }).active,
    ).toBe(false);
  });

  test("registers list, use, status, and off through the extension command", async () => {
    let command;
    const settings = {
      modelFallback: false,
      chains: {},
      revertPolicy: "never",
    };
    const notifications: unknown[] = [];
    const sessionSettings = {
      getRetryFallbackSettings: () => settings,
      setFallbackChain: async (source: string, fallbacks: readonly string[]) => {
        settings.chains[source] = [...fallbacks];
      },
      removeFallbackChain: async (source: string) => {
        delete settings.chains[source];
      },
      setModelFallbackEnabled: async (enabled: boolean) => {
        settings.modelFallback = enabled;
      },
      setFallbackRevertPolicy: async (policy: "cooldown-expiry" | "never") => {
        settings.revertPolicy = policy;
      },
    };
    registerModelPresetCommand({
      registerCommand(_name, definition) {
        command = definition;
      },
    });
    const context = {
      sessionSettings,
      ui: {
        notify(value: unknown) {
          notifications.push(JSON.parse(String(value)));
        },
      },
    };

    await command.handler("list", context);
    await command.handler("use grok-astra", context);
    await command.handler("status grok-astra", context);
    await command.handler("off grok-astra", context);

    expect(notifications[0]).toEqual(["grok-astra"]);
    expect(notifications[1]).toMatchObject({ name: "grok-astra", active: true });
    expect(notifications[2]).toMatchObject({ name: "grok-astra", active: true });
    expect(notifications[3]).toEqual({ name: "grok-astra", active: false });
    expect(settings.chains).toEqual({});
  });

  test("wires OAR account failover before native model fallback", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const requests: Array<Record<string, unknown>> = [];
    let reportCount = 0;
    const requestFn = async (body: Record<string, unknown>) => {
      requests.push(body);
      if (body.action === "resolve") {
        return {
          ok: true,
          data: { profile: reportCount === 0 ? "main" : "sub" },
        };
      }
      if (body.action === "acquire-lease") {
        return { ok: true, data: { id: `lease-${requests.length}` } };
      }
      if (body.action === "release-lease") return { ok: true, data: {} };
      if (body.action === "report") {
        reportCount += 1;
        return reportCount === 1
          ? { ok: true, data: { failover: { from: "main", to: "sub" } } }
          : { ok: true, data: {} };
      }
      throw new Error(`Unexpected action: ${String(body.action)}`);
    };
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(name, handler);
      },
      registerCommand() {},
      notify() {},
    };
    createOarExtension({
      requestFn,
      bootstrapFn: async () => {},
    })(pi);
    const context = {
      sessionSettings: {
        getRetryFallbackSettings: fallbackSettings,
      },
    };

    await handlers.get("before_provider_request")?.({
      model: { provider: "xai", id: "grok-4.5" },
    });
    await handlers.get("after_provider_response")?.({ status: 403, headers: {} });
    const firstDecision = await handlers.get("before_retry_fallback")?.(
      sourceEvent,
      context,
    );

    await handlers.get("before_provider_request")?.({
      model: { provider: "xai", id: "grok-4.5" },
    });
    await handlers.get("after_provider_response")?.({ status: 403, headers: {} });
    const secondDecision = await handlers.get("before_retry_fallback")?.(
      sourceEvent,
      context,
    );

    expect(firstDecision).toEqual({ action: "retry-same-model" });
    expect(secondDecision).toBeUndefined();
    expect(
      requests
        .filter((request) => request.action === "report")
        .map((request) => request.account),
    ).toEqual(["main", "sub"]);
  });
});
