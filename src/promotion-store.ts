import { existsSync, readFileSync } from "node:fs";
import { defaultOarRoot, oarPromotionPath } from "./paths.ts";
import { atomicWriteJson } from "./json-file.ts";
import {
  DEFAULT_PROMOTION_SCHEDULE,
  normalizePromotionSchedule,
  type PromotionSchedule,
} from "./promotion.ts";

export type PromotionFile = {
  version: 1;
  schedule: PromotionSchedule;
  updatedAt: string;
};

export class PromotionStore {
  readonly rootDir: string;
  private readonly path: string;

  constructor(opts?: { rootDir?: string }) {
    this.rootDir = opts?.rootDir ?? defaultOarRoot();
    this.path = oarPromotionPath(this.rootDir);
  }

  get(): PromotionSchedule {
    return this.load().schedule;
  }

  set(schedule: PromotionSchedule): PromotionSchedule {
    const normalized = normalizePromotionSchedule(schedule);
    const file: PromotionFile = {
      version: 1,
      schedule: normalized,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteJson(this.path, file, 0o600);
    return normalized;
  }

  private load(): PromotionFile {
    if (!existsSync(this.path)) {
      return {
        version: 1,
        schedule: { ...DEFAULT_PROMOTION_SCHEDULE },
        updatedAt: new Date(0).toISOString(),
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PromotionFile>;
      if (parsed?.version !== 1 || !parsed.schedule) {
        return {
          version: 1,
          schedule: { ...DEFAULT_PROMOTION_SCHEDULE },
          updatedAt: new Date(0).toISOString(),
        };
      }
      return {
        version: 1,
        schedule: normalizePromotionSchedule(parsed.schedule),
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      };
    } catch {
      return {
        version: 1,
        schedule: { ...DEFAULT_PROMOTION_SCHEDULE },
        updatedAt: new Date(0).toISOString(),
      };
    }
  }
}
