import { describe, expect, it } from "vitest";
import { chromeFramePoint } from "./chrome-hub-input";

describe("Chrome pane input coordinates", () => {
  it("compensates for vertical letterboxing in a narrow split pane", () => {
    const box = { left: 100, top: 50, width: 400, height: 800 };
    const frame = { width: 1600, height: 1000 };
    expect(chromeFramePoint(300, 450, box, frame)).toEqual({ x: 0.5, y: 0.5 });
    expect(chromeFramePoint(300, 100, box, frame)).toBeNull();
    expect(chromeFramePoint(100, 325, box, frame)).toEqual({ x: 0, y: 0 });
  });
  it("ignores empty or outside surfaces", () => {
    expect(chromeFramePoint(0, 0, { left: 0, top: 0, width: 0, height: 20 }, { width: 100, height: 100 })).toBeNull();
    expect(chromeFramePoint(-1, 0, { left: 0, top: 0, width: 20, height: 20 }, { width: 100, height: 100 })).toBeNull();
  });
});
