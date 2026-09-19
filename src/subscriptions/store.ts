import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { defaultOarRoot } from "../paths.ts";

export type SubscriptionPlan = {
  provider: string;
  profile: string;
  monthlyUsd: number;
  planLabel?: string;
  billingCycleDay?: number;
  notes?: string;
};

export type SubscriptionsFile = {
  version: 1;
  plans: SubscriptionPlan[];
  updatedAt: string;
};

function emptyFile(): SubscriptionsFile {
  return { version: 1, plans: [], updatedAt: new Date().toISOString() };
}

function atomicWriteJson(path: string, data: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    // best effort
  }
}

export function subscriptionsPath(root = defaultOarRoot()): string {
  return join(root, "subscriptions.json");
}

export class SubscriptionsStore {
  readonly rootDir: string;
  private readonly path: string;

  constructor(opts?: { rootDir?: string }) {
    this.rootDir = opts?.rootDir ?? defaultOarRoot();
    this.path = subscriptionsPath(this.rootDir);
  }

  load(): SubscriptionsFile {
    if (!existsSync(this.path)) return emptyFile();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as SubscriptionsFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.plans)) return emptyFile();
      return {
        version: 1,
        plans: parsed.plans,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch {
      return emptyFile();
    }
  }

  save(data: SubscriptionsFile): void {
    atomicWriteJson(this.path, { ...data, updatedAt: new Date().toISOString() }, 0o600);
  }

  get(provider: string, profile: string): SubscriptionPlan | undefined {
    return this.load().plans.find((p) => p.provider === provider && p.profile === profile);
  }

  set(plan: SubscriptionPlan): SubscriptionPlan {
    if (!Number.isFinite(plan.monthlyUsd) || plan.monthlyUsd < 0) {
      throw new Error("monthlyUsd must be a non-negative number");
    }
    const data = this.load();
    const idx = data.plans.findIndex((p) => p.provider === plan.provider && p.profile === plan.profile);
    const next: SubscriptionPlan = {
      provider: plan.provider,
      profile: plan.profile,
      monthlyUsd: plan.monthlyUsd,
      ...(plan.planLabel ? { planLabel: plan.planLabel } : {}),
      ...(plan.billingCycleDay != null ? { billingCycleDay: plan.billingCycleDay } : {}),
      ...(plan.notes ? { notes: plan.notes } : {}),
    };
    if (idx >= 0) data.plans[idx] = next;
    else data.plans.push(next);
    this.save(data);
    return next;
  }

  remove(provider: string, profile: string): boolean {
    const data = this.load();
    const before = data.plans.length;
    data.plans = data.plans.filter((p) => !(p.provider === provider && p.profile === profile));
    if (data.plans.length === before) return false;
    this.save(data);
    return true;
  }

  list(): SubscriptionPlan[] {
    return [...this.load().plans].sort((a, b) =>
      a.provider === b.provider ? a.profile.localeCompare(b.profile) : a.provider.localeCompare(b.provider),
    );
  }
}
