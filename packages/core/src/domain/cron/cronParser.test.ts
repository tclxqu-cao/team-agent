import { describe, expect, it } from "vitest";
import { listCronFires } from "./cronParser";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min, 0, 0).getTime();

describe("listCronFires", () => {
  it("lists daily 09:00 fires within the range", () => {
    const fires = listCronFires("0 9 * * *", at(2026, 10, 2), at(2026, 10, 4, 23, 59));
    expect(fires).toEqual([at(2026, 10, 2, 9), at(2026, 10, 3, 9), at(2026, 10, 4, 9)]);
  });

  it("steps interval shorthand from the anchor", () => {
    const fires = listCronFires("6h", at(2026, 10, 2, 0), at(2026, 10, 2, 23, 59), { anchorMs: at(2026, 10, 2, 0) });
    expect(fires).toEqual([at(2026, 10, 2, 0), at(2026, 10, 2, 6), at(2026, 10, 2, 12), at(2026, 10, 2, 18)]);
  });

  it("aligns interval fires into the range when the anchor precedes it", () => {
    const fires = listCronFires("6h", at(2026, 10, 2, 7), at(2026, 10, 2, 23, 59), { anchorMs: at(2026, 10, 2, 0) });
    expect(fires[0]).toBe(at(2026, 10, 2, 12));
  });

  it("respects the limit and rejects invalid expressions", () => {
    expect(listCronFires("* * * * *", at(2026, 10, 2), at(2026, 10, 2, 23, 59), { limit: 5 })).toHaveLength(5);
    expect(listCronFires("not a cron", at(2026, 10, 2), at(2026, 10, 3))).toEqual([]);
  });
});