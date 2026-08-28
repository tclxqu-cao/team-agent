import { describe, expect, it } from "vitest";
import { resetHorizontalScroll, resolveVisualViewport } from "./mobileViewport";

describe("resolveVisualViewport", () => {
  it("uses and rounds visual viewport dimensions and offsets", () => {
    expect(resolveVisualViewport({
      height: 701.6,
      width: 389.5,
      offsetTop: 47.4,
      offsetLeft: 12.6,
    }, { height: 844, width: 390 })).toEqual({
      height: 702,
      width: 390,
      top: 47,
      left: 13,
    });
  });

  it("falls back to the layout viewport", () => {
    expect(resolveVisualViewport(null, { height: 844, width: 390 })).toEqual({
      height: 844,
      width: 390,
      top: 0,
      left: 0,
    });
  });
});

describe("resetHorizontalScroll", () => {
  it("returns a horizontally scrolled rail to its leading edge", () => {
    const rail = { scrollLeft: 238 };
    resetHorizontalScroll(rail);
    expect(rail.scrollLeft).toBe(0);
  });
});
