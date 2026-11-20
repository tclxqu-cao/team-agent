import { describe, expect, it } from "vitest";
import { BrowserLiveTouch } from "./browser-live-touch";

describe("live touch gestures", () => {
  it("does not pinch when a new primary touch follows an interrupted gesture", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 10, y: 50 }, true);
    gesture.down(2, { x: 110, y: 50 }, true);
    expect(gesture.move(2, { x: 160, y: 50 })).toEqual({
      scale: 1, distanceRatio: 1, from: { x: 110, y: 50 }, to: { x: 160, y: 50 }, pointers: 1,
    });
    expect(gesture.move(1, { x: 0, y: 50 })).toBeNull();
    expect(gesture.up(2, { x: 160, y: 50 })).toBe(false);
  });

  it("commits a short tap only on release", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 40, y: 60 });
    expect(gesture.move(1, { x: 43, y: 62 })).toBeNull();
    expect(gesture.up(1, { x: 43, y: 62 })).toBe(true);
  });
  it("pans without clicking even if the finger returns to its origin", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 40, y: 60 });
    expect(gesture.move(1, { x: 80, y: 90 })).toEqual({ scale: 1, distanceRatio: 1, from: { x: 40, y: 60 }, to: { x: 80, y: 90 }, pointers: 1 });
    gesture.move(1, { x: 40, y: 60 });
    expect(gesture.up(1, { x: 40, y: 60 })).toBe(false);
  });
  it("pinches around the midpoint and never clicks after either finger lifts", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 0, y: 50 }, true);
    gesture.down(2, { x: 100, y: 50 }, false);
    expect(gesture.move(2, { x: 200, y: 50 })).toEqual({ scale: 2, distanceRatio: 2, from: { x: 50, y: 50 }, to: { x: 100, y: 50 }, pointers: 2 });
    expect(gesture.move(2, { x: 50, y: 50 })).toMatchObject({ scale: 0.25, distanceRatio: 0.5, pointers: 2 });
    expect(gesture.up(2, { x: 50, y: 50 })).toBe(false);
    expect(gesture.move(1, { x: 50, y: 50 })).toMatchObject({ scale: 1, distanceRatio: 1, pointers: 1 });
    expect(gesture.up(1, { x: 50, y: 50 })).toBe(false);
    gesture.down(3, { x: 20, y: 20 });
    expect(gesture.up(3, { x: 20, y: 20 })).toBe(true);
  });

  it("ignores three-finger movement and rebases the remaining two fingers", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 0, y: 0 }, true);
    gesture.down(2, { x: 100, y: 0 }, false);
    gesture.down(3, { x: 160, y: 0 }, false);
    expect(gesture.move(2, { x: 150, y: 0 })).toBeNull();
    expect(gesture.up(1, { x: 0, y: 0 })).toBe(false);
    expect(gesture.move(2, { x: 152, y: 0 })).toMatchObject({ distanceRatio: 0.8, pointers: 2 });
  });
  it("keeps reporting two pointers while both fingers drag without zooming", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 0, y: 0 });
    gesture.down(2, { x: 100, y: 0 });
    const movement = gesture.move(1, { x: 10, y: 40 });
    expect(movement).toMatchObject({ from: { x: 50, y: 0 }, to: { x: 55, y: 20 }, pointers: 2 });
  });
  it("reports the cumulative pinch ratio so translation jitter stays near 1", () => {
    const gesture = new BrowserLiveTouch();
    gesture.down(1, { x: 0, y: 0 });
    gesture.down(2, { x: 100, y: 0 });
    // Parallel translation with millimetre jitter: the distance barely moves.
    const translated = gesture.move(1, { x: 4, y: 30 });
    expect(translated && Math.abs(translated.distanceRatio - 1)).toBeLessThan(0.05);
    // A deliberate pinch grows the ratio against the gesture-start distance.
    const pinched = gesture.move(2, { x: 220, y: 30 });
    expect(pinched && pinched.distanceRatio).toBeGreaterThan(1.5);
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
