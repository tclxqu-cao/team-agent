import { describe, expect, it } from "vitest";
import { popoverTop } from "./popover-position";

describe("compact toolbar popover placement", () => {
  it("keeps a top toolbar popover below its trigger", () => {
    expect(popoverTop({ top: 8, bottom: 52 }, 332, 844)).toBe(58);
  });
  it("opens above the phone bottom sheet instead of clipping the theme list", () => {
    expect(popoverTop({ top: 680, bottom: 744 }, 332, 844)).toBe(342);
  });
  it("keeps an oversized popover within the top viewport inset", () => {
    expect(popoverTop({ top: 80, bottom: 124 }, 332, 240)).toBe(8);
  });
});
