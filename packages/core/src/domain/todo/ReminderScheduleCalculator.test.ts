import { describe, expect, it } from "vitest";
import { ReminderScheduleCalculator } from "./ReminderScheduleCalculator";
describe("timezone-aware Todo triggers", () => {
  const calculator = new ReminderScheduleCalculator();
  const next = (cron: string, zone: string, after: string) => new Date(calculator.next({ kind: "cron", expression: cron }, zone, Date.parse(after))!).toISOString();
  it("uses the persisted IANA zone instead of the machine local zone", () => { expect(next("0 9 * * *", "Asia/Shanghai", "2026-11-17T00:00:00Z")).toBe("2026-11-17T01:00:00.000Z"); });
  it("skips nonexistent spring-forward times", () => { expect(next("30 2 * * *", "America/New_York", "2026-03-08T05:00:00Z")).toBe("2026-03-09T06:30:00.000Z"); });
  it("fires only the first occurrence of a repeated fall-back minute", () => { expect(next("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z")).toBe("2026-11-01T05:30:00.000Z"); expect(next("30 1 * * *", "America/New_York", "2026-11-01T05:31:00Z")).toBe("2026-11-02T06:30:00.000Z"); });
  it("rejects invalid fields, zones and past one-shot timestamps", () => { expect(() => next("90 * * * *", "Asia/Shanghai", "2026-11-17T00:00:00Z")).toThrow("范围"); expect(() => next("* * * * *", "unknown/zone", "2026-11-17T00:00:00Z")).toThrow("时区"); expect(calculator.next({ kind: "once", at: 100 }, "Asia/Shanghai", 101)).toBeNull(); });
});
