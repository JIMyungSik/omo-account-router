import type { OarStore } from "../store.ts";
import type { ProviderAdapter } from "./types.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { GenericAdapter } from "./generic.ts";
import { OpenaiCodexAdapter } from "./openai-codex.ts";
import { OpenrouterAdapter } from "./openrouter.ts";
import { XaiAdapter } from "./xai.ts";

/**
 * Providers known to have no dedicated adapter yet but that OAR should still
 * vault + hot-switch (e.g. discovered from auth.json via `import-auth --all`).
 * Falling through to GenericAdapter here means: no invented refresh flow,
 * local-only health check, hot-switch still works via auth.json slot write.
 */
const KNOWN_GENERIC_PROVIDERS = new Set(["opencode-go", "zai-coding-cn"]);

export function createAdapter(provider: string, store: OarStore): ProviderAdapter | undefined {
  switch (provider) {
    case "xai":
      return new XaiAdapter(store);
    case "anthropic":
      return new AnthropicAdapter(store);
    case "openai-codex":
      return new OpenaiCodexAdapter(store);
    case "openrouter":
      return new OpenrouterAdapter(store);
    default:
      if (KNOWN_GENERIC_PROVIDERS.has(provider)) {
        return new GenericAdapter(provider, store);
      }
      // Unknown provider discovered at runtime (e.g. import-auth --all found a
      // slot OAR has never seen): still vault/hot-switch it generically rather
      // than silently dropping it.
      return new GenericAdapter(provider, store);
  }
}

export { AnthropicAdapter, GenericAdapter, OpenaiCodexAdapter, OpenrouterAdapter, XaiAdapter };
