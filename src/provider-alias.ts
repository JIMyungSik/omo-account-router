/** User-facing provider ids. OMO now stores Codex subscription auth as chatgpt-subscription. */
export const PROVIDER_ALIASES = {
  "chatgpt-subscription": "chatgpt-subscription",
  "openai-codex": "chatgpt-subscription",
  openai: "chatgpt-subscription",
  codex: "chatgpt-subscription",
  chatgpt: "chatgpt-subscription",
  xai: "xai",
  grok: "xai",
} as const;

export function resolveProvider(input: string): string {
  const key = input.trim().toLowerCase();
  return PROVIDER_ALIASES[key as keyof typeof PROVIDER_ALIASES] ?? input.trim();
}

export function isCodexProvider(provider: string): boolean {
  return resolveProvider(provider) === "chatgpt-subscription";
}

export function isXaiProvider(provider: string): boolean {
  return resolveProvider(provider) === "xai";
}
