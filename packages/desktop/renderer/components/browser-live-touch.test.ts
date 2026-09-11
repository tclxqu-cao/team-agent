import { describe, expect, it } from "vitest";
import { BrowserLiveTouch } from "./browser-live-touch";

describe("live touch gestures", () => {
  it("commits a short tap only on release", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 40, y: 60 });
    expect(gesture.move(1, { x: 43, y: 62 })).toBeNull();
    expect(gesture.up(1, { x: 43, y: 62 })).toBe(true);
  });
  it("pans without clicking even if the finger returns to its origin", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 40, y: 60 });
    expect(gesture.move(1, { x: 80, y: 90 })).toEqual({ scale: 1, from: { x: 40, y: 60 }, to: { x: 80, y: 90 } });
    gesture.move(1, { x: 40, y: 60 });
    expect(gesture.up(1, { x: 40, y: 60 })).toBe(false);
  });
  it("pinches around the midpoint and never clicks after either finger lifts", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 0, y: 50 });
    gesture.down(2, { x: 100, y: 50 });
    expect(gesture.move(2, { x: 200, y: 50 })).toEqual({ scale: 2, from: { x: 50, y: 50 }, to: { x: 100, y: 50 } });
    expect(gesture.up(2, { x: 200, y: 50 })).toBe(false);
    expect(gesture.up(1, { x: 0, y: 50 })).toBe(false);
    gesture.down(3, { x: 20, y: 20 });
    expect(gesture.up(3, { x: 20, y: 20 })).toBe(true);
  });
  it("cancels interrupted gestures and rejects untracked releases", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 20, y: 20 });
    expect(gesture.up(1, { x: 20, y: 20 }, true)).toBe(false);
    expect(gesture.up(1, { x: 20, y: 20 })).toBe(false);
    gesture.down(2, { x: 20, y: 20 });
    gesture.reset();
    expect(gesture.up(2, { x: 20, y: 20 })).toBe(false);
  });
});
