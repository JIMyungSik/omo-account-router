import { describe, expect, test } from "bun:test";
import {
  isInPromotionWindow,
  localMinutes,
  nextWindowBoundary,
  normalizePromotionSchedule,
  promotionalModelSelector,
  promotionStatusView,
  zonedCivilToUtc,
  type PromotionSchedule,
} from "../src/promotion.ts";

const SEOUL: PromotionSchedule = {
  enabled: true,
  timezone: "Asia/Seoul",
  start: "00:00",
  end: "10:00",
  provider: "opengateway",
  model: "deepseek/deepseek-v4.1-flash-ultrafast",
  maxConcurrency: 3,
  maxAttempts: 3,
};

function utc(iso: string): number {
  return Date.parse(iso);
}

describe("promotional daily window", () => {
  test("defaults to Seoul DeepSeek ultrafast at concurrency 3", () => {
    const schedule = normalizePromotionSchedule({ enabled: true });
    expect(schedule).toMatchObject({
      timezone: "Asia/Seoul",
      start: "00:00",
      end: "10:00",
      provider: "opengateway",
      model: "deepseek/deepseek-v4.1-flash-ultrafast",
      maxConcurrency: 3,
      maxAttempts: 3,
    });
    expect(promotionalModelSelector(schedule)).toBe(
      "opengateway/deepseek/deepseek-v4.1-flash-ultrafast",
    );
  });

  test("includes 00:00 and 09:59 and excludes 10:00 in Asia/Seoul", () => {
    const midnight = utc("2026-10-02T15:00:00.000Z");
    const lastMinute = utc("2026-10-03T00:59:00.000Z");
    const ten = utc("2026-10-03T01:00:00.000Z");
    expect(localMinutes(midnight, "Asia/Seoul")).toBe(0);
    expect(localMinutes(lastMinute, "Asia/Seoul")).toBe(9 * 60 + 59);
    expect(localMinutes(ten, "Asia/Seoul")).toBe(10 * 60);
    expect(isInPromotionWindow(midnight, SEOUL)).toBe(true);
    expect(isInPromotionWindow(lastMinute, SEOUL)).toBe(true);
    expect(isInPromotionWindow(ten, SEOUL)).toBe(false);
  });

  test("disabled schedules are never in window even inside hours", () => {
    expect(isInPromotionWindow(utc("2026-10-02T15:00:00.000Z"), { ...SEOUL, enabled: false })).toBe(
      false,
    );
  });

  test("overnight ranges wrap midnight", () => {
    const overnight = { ...SEOUL, start: "22:00", end: "06:00" };
    expect(isInPromotionWindow(utc("2026-10-03T12:59:00.000Z"), overnight)).toBe(false);
    expect(isInPromotionWindow(utc("2026-10-03T13:00:00.000Z"), overnight)).toBe(true);
    expect(isInPromotionWindow(utc("2026-10-02T20:59:00.000Z"), overnight)).toBe(true);
    expect(isInPromotionWindow(utc("2026-10-02T21:00:00.000Z"), overnight)).toBe(false);
  });

  test("timezone handling uses injected instants, not the host zone", () => {
    const ny: PromotionSchedule = { ...SEOUL, timezone: "America/New_York" };
    const nyMidnight = zonedCivilToUtc("America/New_York", 2026, 10, 3, 0, 0);
    const nyTen = zonedCivilToUtc("America/New_York", 2026, 10, 3, 10, 0);
    expect(isInPromotionWindow(nyMidnight, ny)).toBe(true);
    expect(isInPromotionWindow(nyTen, ny)).toBe(false);
    expect(isInPromotionWindow(nyMidnight, SEOUL)).toBe(false);
  });

  test("next boundary after 00:00 KST is the exclusive 10:00 exit", () => {
    const midnight = utc("2026-10-02T15:00:00.000Z");
    const next = nextWindowBoundary(midnight, SEOUL);
    expect(next).toEqual({ at: utc("2026-10-03T01:00:00.000Z"), entering: false });
    expect(promotionStatusView(SEOUL, midnight).nextBoundary).toEqual({
      at: "2026-10-03T01:00:00.000Z",
      entering: false,
    });
  });

  test("rejects invalid clocks and timezones", () => {
    expect(() => normalizePromotionSchedule({ start: "24:00" })).toThrow(/invalid time/);
    expect(() => normalizePromotionSchedule({ timezone: "Not/AZone" })).toThrow(/invalid timezone/);
  });
});
