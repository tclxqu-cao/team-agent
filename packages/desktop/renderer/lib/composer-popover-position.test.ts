import { describe, expect, it } from "vitest";
import { composerPopoverPosition } from "./composer-popover-position";

describe("composerPopoverPosition", () => {
  const viewport = { top: 0, left: 0, width: 1200, height: 900 };

  it("keeps a directory menu inside the leftmost narrow task column", () => {
    const result = composerPopoverPosition({ top: 700, right: 190, bottom: 736 }, viewport, 420);
    expect(result).toEqual({ left: 16, top: 272, width: 320, maxHeight: 420 });
  });

  it("clamps the menu to the right window edge", () => {
    const result = composerPopoverPosition({ top: 700, right: 1210, bottom: 736 }, viewport, 420);
    expect(result.left + result.width).toBe(1184);
  });

  it("opens below a high composer and constrains a tall workspace list", () => {
    const result = composerPopoverPosition({ top: 40, right: 220, bottom: 76 }, { ...viewport, height: 300 }, 700);
    expect(result.top).toBe(84);
    expect(result.maxHeight).toBe(200);
    expect(result.top + result.maxHeight).toBe(284);
  });

  it("uses the visible mobile viewport including offsets and available width", () => {
    const result = composerPopoverPosition({ top: 380, right: 280, bottom: 416 }, { top: 120, left: 20, width: 280, height: 360 }, 420);
    expect(result.left).toBe(36);
    expect(result.width).toBe(248);
    expect(result.top).toBe(136);
    expect(result.maxHeight).toBe(236);
  });
});
