import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { defaultOarRoot, oarModelPinPath } from "./paths.ts";
import { atomicWriteJson } from "./json-file.ts";

export type ModelPin = {
  /** Changes on every `set`; sessions apply each pin id at most once. */
  id: string;
  provider: string;
  model: string;
  thinking?: string;
  setAt: string;
};

export type ModelPinStatusView =
  | { active: false }
  | ({ active: true; modelSelector: string } & ModelPin);

/** Split "provider/model-id". Model ids may contain "/", provider ids may not. */
export function parseModelSelector(selector: string): { provider: string; model: string } {
  const idx = selector.indexOf("/");
  const provider = idx > 0 ? selector.slice(0, idx).trim() : "";
  const model = idx > 0 ? selector.slice(idx + 1).trim() : "";
  if (!provider || !model) throw new Error(`invalid model ${selector}; use <provider>/<model-id>`);
  return { provider, model };
}

export function modelPinStatusView(pin: ModelPin | undefined): ModelPinStatusView {
  return pin ? { active: true, modelSelector: `${pin.provider}/${pin.model}`, ...pin } : { active: false };
}

export class ModelPinStore {
  readonly rootDir: string;
  private readonly path: string;

  constructor(opts?: { rootDir?: string }) {
    this.rootDir = opts?.rootDir ?? defaultOarRoot();
    this.path = oarModelPinPath(this.rootDir);
  }

  get(): ModelPin | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ModelPin>;
      if (!parsed?.id || !parsed.provider || !parsed.model) return undefined;
      return {
        id: parsed.id,
        provider: parsed.provider,
        model: parsed.model,
        ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
        setAt: parsed.setAt ?? new Date(0).toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  set(input: { provider: string; model: string; thinking?: string }, nowMs = Date.now()): ModelPin {
    const pin: ModelPin = {
      id: randomUUID(),
      provider: input.provider,
      model: input.model,
      ...(input.thinking ? { thinking: input.thinking } : {}),
      setAt: new Date(nowMs).toISOString(),
    };
    atomicWriteJson(this.path, pin, 0o600);
    return pin;
  }

  clear(): void {
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}
