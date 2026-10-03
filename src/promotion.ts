export type PromotionSchedule = {
  enabled: boolean;
  timezone: string;
  start: string;
  end: string;
  provider: string;
  model: string;
  maxConcurrency: number;
  maxAttempts: number;
};

export type PromotionBoundary = {
  at: string;
  entering: boolean;
};

export type PromotionStatusView = PromotionSchedule & {
  modelSelector: string;
  inWindow: boolean;
  insideHours: boolean;
  now: string;
  nextBoundary?: PromotionBoundary;
};

export const DEFAULT_PROMOTION_SCHEDULE: PromotionSchedule = {
  enabled: false,
  timezone: "Asia/Seoul",
  start: "00:00",
  end: "10:00",
  provider: "opengateway",
  model: "deepseek/deepseek-v4.1-flash-ultrafast",
  maxConcurrency: 3,
  maxAttempts: 3,
};

export function promotionalModelSelector(schedule: Pick<PromotionSchedule, "provider" | "model">): string {
  return `${schedule.provider}/${schedule.model}`;
}

export function parseClock(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`invalid time ${hhmm}; use HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`invalid time ${hhmm}; use HH:MM`);
  return hour * 60 + minute;
}

export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`invalid timezone ${timeZone}`);
  }
}

export function normalizePromotionSchedule(raw: Partial<PromotionSchedule> | undefined): PromotionSchedule {
  const next: PromotionSchedule = {
    enabled: Boolean(raw?.enabled),
    timezone: typeof raw?.timezone === "string" && raw.timezone ? raw.timezone : DEFAULT_PROMOTION_SCHEDULE.timezone,
    start: typeof raw?.start === "string" && raw.start ? raw.start : DEFAULT_PROMOTION_SCHEDULE.start,
    end: typeof raw?.end === "string" && raw.end ? raw.end : DEFAULT_PROMOTION_SCHEDULE.end,
    provider: typeof raw?.provider === "string" && raw.provider ? raw.provider : DEFAULT_PROMOTION_SCHEDULE.provider,
    model: typeof raw?.model === "string" && raw.model ? raw.model : DEFAULT_PROMOTION_SCHEDULE.model,
    maxConcurrency: Number.isInteger(raw?.maxConcurrency) && (raw?.maxConcurrency ?? 0) >= 1
      ? Number(raw?.maxConcurrency)
      : DEFAULT_PROMOTION_SCHEDULE.maxConcurrency,
    maxAttempts: Number.isInteger(raw?.maxAttempts) && (raw?.maxAttempts ?? 0) >= 1
      ? Number(raw?.maxAttempts)
      : DEFAULT_PROMOTION_SCHEDULE.maxAttempts,
  };
  parseClock(next.start);
  parseClock(next.end);
  assertValidTimeZone(next.timezone);
  if (!next.provider.trim() || !next.model.trim()) {
    throw new Error("provider and model are required");
  }
  return next;
}

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function readZonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedOffsetMs(instant: Date, timeZone: string): number {
  const parts = readZonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}

export function zonedCivilToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zonedOffsetMs(new Date(utcGuess), timeZone);
  let utc = utcGuess - offset;
  const offset2 = zonedOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset) utc = utcGuess - offset2;
  return utc;
}

function addCivilDays(year: number, month: number, day: number, delta: number): {
  year: number;
  month: number;
  day: number;
} {
  const dt = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

export function localMinutes(nowMs: number, timeZone: string): number {
  const parts = readZonedParts(new Date(nowMs), timeZone);
  return parts.hour * 60 + parts.minute;
}

export function isInsidePromotionHours(nowMs: number, schedule: PromotionSchedule): boolean {
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  if (start === end) return false;
  const minutes = localMinutes(nowMs, schedule.timezone);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function isInPromotionWindow(nowMs: number, schedule: PromotionSchedule): boolean {
  return schedule.enabled && isInsidePromotionHours(nowMs, schedule);
}

export function nextWindowBoundary(
  nowMs: number,
  schedule: PromotionSchedule,
): { at: number; entering: boolean } | undefined {
  if (!schedule.enabled) return undefined;
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  if (start === end) return undefined;
  const parts = readZonedParts(new Date(nowMs), schedule.timezone);
  const startHour = Math.floor(start / 60);
  const startMinute = start % 60;
  const endHour = Math.floor(end / 60);
  const endMinute = end % 60;
  const candidates: Array<{ at: number; entering: boolean }> = [];
  for (const delta of [-1, 0, 1, 2]) {
    const day = addCivilDays(parts.year, parts.month, parts.day, delta);
    candidates.push({
      at: zonedCivilToUtc(schedule.timezone, day.year, day.month, day.day, startHour, startMinute),
      entering: true,
    });
    candidates.push({
      at: zonedCivilToUtc(schedule.timezone, day.year, day.month, day.day, endHour, endMinute),
      entering: false,
    });
  }
  return candidates.filter((item) => item.at > nowMs).sort((a, b) => a.at - b.at)[0];
}

export function promotionStatusView(schedule: PromotionSchedule, nowMs: number): PromotionStatusView {
  const insideHours = isInsidePromotionHours(nowMs, schedule);
  const next = nextWindowBoundary(nowMs, schedule);
  return {
    ...schedule,
    modelSelector: promotionalModelSelector(schedule),
    insideHours,
    inWindow: schedule.enabled && insideHours,
    now: new Date(nowMs).toISOString(),
    ...(next
      ? { nextBoundary: { at: new Date(next.at).toISOString(), entering: next.entering } }
      : {}),
  };
}
