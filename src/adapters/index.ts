import type { OarStore } from "../store.ts";
import type { ProviderAdapter } from "./types.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { OpenaiCodexAdapter } from "./openai-codex.ts";
import { XaiAdapter } from "./xai.ts";

export function createAdapter(provider: string, store: OarStore): ProviderAdapter | undefined {
  switch (provider) {
    case "xai":
      return new XaiAdapter(store);
    case "anthropic":
      return new AnthropicAdapter(store);
    case "openai-codex":
      return new OpenaiCodexAdapter(store);
    default:
      return undefined;
  }
}

export { AnthropicAdapter, OpenaiCodexAdapter, XaiAdapter };
