import { describe, expect, it } from "vitest";
import { initialImageViewport, moveImage, zoomImage } from "./image-viewport";

describe("image viewport", () => {
  it("zooms around the finger midpoint and clamps scale", () => {
    expect(zoomImage(initialImageViewport(), 2, { x: 50, y: 20 })).toEqual({ scale: 2, x: -50, y: -20 });
    expect(zoomImage(initialImageViewport(), 20).scale).toBe(6);
    expect(zoomImage({ scale: 3, x: 200, y: 100 }, 0.5)).toEqual(initialImageViewport());
  });
  it("pinches and then pans with the remaining finger", () => {
    const view = moveImage(initialImageViewport(), [{ x: -50, y: 0 }, { x: 50, y: 0 }], [{ x: -100, y: 10 }, { x: 100, y: 10 }]);
    expect(view).toEqual({ scale: 2, x: 0, y: 10 });
    expect(moveImage(view, [{ x: 100, y: 10 }], [{ x: 120, y: 30 }])).toEqual({ scale: 2, x: 20, y: 30 });
  });
  it("keeps fit images centered and handles coincident pointers", () => {
    expect(moveImage(initialImageViewport(), [{ x: 0, y: 0 }], [{ x: 40, y: 40 }])).toEqual(initialImageViewport());
    expect(moveImage(initialImageViewport(), [{ x: 0, y: 0 }, { x: 0, y: 0 }], [{ x: 1, y: 0 }, { x: 1, y: 0 }])).toEqual(initialImageViewport());
  });
});
