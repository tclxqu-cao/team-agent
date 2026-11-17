import { describe, expect, it } from "vitest";
import { describeRRule, expandRRule, expandWhen } from "./schedule-expand";

const day = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min, 0, 0).getTime();
// 2026-11-02 is a Monday.
const MON = day(2026, 10, 2);

describe("expandRRule", () => {
  it("expands daily fires at the configured local time", () => {
    const fires = expandRRule("FREQ=DAILY;BYHOUR=19;BYMINUTE=0", day(2026, 10, 2), day(2026, 10, 4, 23, 59));
    expect(fires).toEqual([day(2026, 10, 2, 19), day(2026, 10, 3, 19), day(2026, 10, 4, 19)]);
  });

  it("expands weekly BYDAY anchored to the start week", () => {
    const fires = expandRRule("RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", day(2026, 10, 1), day(2026, 10, 30, 23, 59), { anchorMs: MON });
    expect(fires).toEqual([day(2026, 10, 2, 9), day(2026, 10, 9, 9), day(2026, 10, 16, 9), day(2026, 10, 23, 9), day(2026, 10, 30, 9)]);
  });

  it("honours INTERVAL for daily stepping", () => {
    const fires = expandRRule("FREQ=DAILY;INTERVAL=2;BYHOUR=8", day(2026, 10, 2), day(2026, 10, 8, 23, 59), { anchorMs: MON });
    expect(fires).toEqual([day(2026, 10, 2, 8), day(2026, 10, 4, 8), day(2026, 10, 6, 8), day(2026, 10, 8, 8)]);
  });

  it("caps expansion at UNTIL", () => {
    const fires = expandRRule("FREQ=DAILY;BYHOUR=9;UNTIL=20261104T000000Z", day(2026, 10, 2), day(2026, 10, 10, 23, 59));
    expect(fires.length).toBeLessThanOrEqual(3);
    expect(fires.every(ms => ms <= Date.parse("2026-11-04T00:00:00Z"))).toBe(true);
  });

  it("steps hourly intervals from the anchor", () => {
    const fires = expandRRule("FREQ=HOURLY;INTERVAL=6", day(2026, 10, 2, 0), day(2026, 10, 2, 23, 59), { anchorMs: day(2026, 10, 2, 0) });
    expect(fires).toEqual([day(2026, 10, 2, 0), day(2026, 10, 2, 6), day(2026, 10, 2, 12), day(2026, 10, 2, 18)]);
  });

  it("expands monthly BYMONTHDAY", () => {
    const fires = expandRRule("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=7", day(2026, 10, 1), day(2027, 0, 31, 23, 59), { anchorMs: day(2026, 10, 1) });
    expect(fires).toEqual([day(2026, 10, 1, 7), day(2026, 11, 1, 7), day(2027, 0, 1, 7)]);
  });

  it("returns empty for an unsupported frequency", () => {
    expect(expandRRule("FREQ=SECONDLY", MON, MON + 86_400_000)).toEqual([]);
  });
});

describe("describeRRule", () => {
  it("labels weekly rules in Chinese", () => {
    expect(describeRRule("RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0")).toBe("每周一 09:00");
  });
  it("labels daily rules", () => {
    expect(describeRRule("FREQ=DAILY;BYHOUR=19;BYMINUTE=0")).toBe("每天 19:00");
  });
  it("labels hourly intervals", () => {
    expect(describeRRule("FREQ=HOURLY;INTERVAL=6")).toBe("每 6 小时");
  });
});

describe("expandWhen", () => {
  it("detects RRULE", () => {
    const result = expandWhen("RRULE:FREQ=DAILY;BYHOUR=9", day(2026, 10, 2), day(2026, 10, 3, 23, 59));
    expect(result.oneShot).toBe(false);
    expect(result.fires.length).toBe(2);
  });
  it("detects a one-shot ISO timestamp", () => {
    const result = expandWhen("2026-11-03T10:00:00", day(2026, 10, 2), day(2026, 10, 4, 23, 59));
    expect(result.oneShot).toBe(true);
    expect(result.fires.length).toBe(1);
  });
  it("expands a 5-field cron expression", () => {
    const result = expandWhen("0 9 * * *", day(2026, 10, 2), day(2026, 10, 4, 23, 59));
    expect(result.fires.length).toBe(3);
    expect(result.oneShot).toBe(false);
  });
  it("expands interval shorthand", () => {
    const result = expandWhen("6h", day(2026, 10, 2, 0), day(2026, 10, 2, 23, 59), { anchorMs: day(2026, 10, 2, 0) });
    expect(result.fires.length).toBe(4);
  });
});