/**
 * Register Cursor as an OMO/Senpi provider via local cursor-bridge.
 *
 * Requires:
 *   1. cursor-agent installed + logged in (or CURSOR_API_KEY)
 *   2. cursor-bridge running (scripts/cursor-bridge.mjs or LaunchAgent)
 *
 * Models use Cursor's first-party pool (Cursor Grok / Composer), NOT xAI OAuth.
 * Tool-calling parity with native OMO tools is limited — prefer OAR auto xAI
 * for full tool loops; use cursor/* for Cursor-pool coding bursts.
 */
const BRIDGE = process.env.CURSOR_BRIDGE_URL || "http://127.0.0.1:18765/v1";

const MODELS = [
  {
    id: "cursor-grok-4.6-high",
    name: "Cursor Grok 4.6",
    reasoning: true,
    input: ["text"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: "cursor-grok-4.6-high-fast",
    name: "Cursor Grok 4.6 Fast",
    reasoning: true,
    input: ["text"],
    cost: { input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: "composer-2.5",
    name: "Composer 2.5",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: "composer-2.5-fast",
    name: "Composer 2.5 Fast",
    reasoning: false,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
];

async function bridgeUp() {
  try {
    const res = await fetch(`${BRIDGE.replace(/\/v1\/?$/, "")}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default async function (pi) {
  const up = await bridgeUp();
  if (!up) {
    // Still register so /models lists cursor once bridge starts; requests fail loudly until then.
    if (process.env.OAR_DEBUG) {
      console.warn("[cursor-omo] bridge not reachable at", BRIDGE, "— start scripts/cursor-bridge.mjs");
    }
  }

  pi.registerProvider("cursor", {
    name: "Cursor (bridge → cursor-agent)",
    baseUrl: BRIDGE,
    apiKey: process.env.CURSOR_API_KEY || "cursor-bridge",
    api: "openai-completions",
    models: MODELS,
  });

  pi.registerCommand("cursor-bridge", {
    description: "Check local Cursor bridge health for OMO cursor/* models",
    handler: async (_args, ctx) => {
      const ok = await bridgeUp();
      ctx.ui.notify(
        ok
          ? `cursor-bridge OK at ${BRIDGE}`
          : `cursor-bridge DOWN (${BRIDGE}). Run: node omo-account-router/scripts/cursor-bridge.mjs`,
        ok ? "info" : "warning",
      );
    },
  });
}
