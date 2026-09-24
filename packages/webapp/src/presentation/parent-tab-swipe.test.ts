import { describe, expect, it, vi } from "vitest";
import {
  createParentTabSwipeGesture,
  isParentTabSwipeInteractiveTarget,
  WEBAPP_TAB_SWIPE_MESSAGE_TYPE,
} from "./parent-tab-swipe";

const touch = (overrides: Partial<Parameters<ReturnType<typeof createParentTabSwipeGesture>["pointerDown"]>[0]> = {}) => ({
  pointerId: 7,
  pointerType: "touch",
  isPrimary: true,
  clientX: 100,
  clientY: 200,
  viewportWidth: 390,
  ...overrides,
});

describe("parent tab swipe gesture", () => {
  it("emits move and end messages for a horizontal swipe", () => {
    const emit = vi.fn();
    const gesture = createParentTabSwipeGesture(emit);

    gesture.pointerDown(touch({ clientX: 390 }));
    expect(gesture.pointerMove(touch({ clientX: 360, clientY: 202 }))).toBe(true);
    expect(gesture.pointerUp(touch({ clientX: 310, clientY: 203 }))).toBe(true);

    expect(emit).toHaveBeenNthCalledWith(1, {
      type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE,
      phase: "move",
      deltaX: -30,
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE,
      phase: "end",
      deltaX: -80,
    });
  });

  it("accepts starts on both 24px edge boundaries", () => {
    const emit = vi.fn();
    const gesture = createParentTabSwipeGesture(emit);

    gesture.pointerDown(touch({ clientX: 24 }));
    expect(gesture.pointerMove(touch({ clientX: 54 }))).toBe(true);
    gesture.pointerUp(touch({ clientX: 80 }));

    gesture.pointerDown(touch({ clientX: 366 }));
    expect(gesture.pointerMove(touch({ clientX: 336 }))).toBe(true);
  });

  it("does not claim horizontal gestures that start outside the edge zones", () => {
    const emit = vi.fn();
    const gesture = createParentTabSwipeGesture(emit);

    gesture.pointerDown(touch({ clientX: 25 }));
    expect(gesture.pointerMove(touch({ clientX: 100 }))).toBe(false);
    expect(gesture.pointerUp(touch({ clientX: 150 }))).toBe(false);

    gesture.pointerDown(touch({ clientX: 365 }));
    expect(gesture.pointerMove(touch({ clientX: 300 }))).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("abandons a vertical gesture without emitting", () => {
    const emit = vi.fn();
    const gesture = createParentTabSwipeGesture(emit);

    gesture.pointerDown(touch({ clientX: 10 }));
    expect(gesture.pointerMove(touch({ clientX: 14, clientY: 230 }))).toBe(false);
    expect(gesture.pointerUp(touch({ clientX: 15, clientY: 250 }))).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores gestures that begin on interactive controls", () => {
    const emit = vi.fn();
    const gesture = createParentTabSwipeGesture(emit);

    gesture.pointerDown(touch({ clientX: 10, interactive: true }));
    expect(gesture.pointerMove(touch({ clientX: 20 }))).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits cancel after horizontal tracking starts", () => {
    const emit = vi.fn();
    const gesture = createParentTabSwipeGesture(emit);

    gesture.pointerDown(touch({ clientX: 10 }));
    gesture.pointerMove(touch({ clientX: 40 }));
    expect(gesture.pointerCancel(touch({ clientX: 40 }))).toBe(true);
    expect(emit).toHaveBeenLastCalledWith({
      type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE,
      phase: "cancel",
      deltaX: 0,
    });
  });
});

describe("interactive swipe targets", () => {
  it("uses the interactive selector when closest is available", () => {
    const closest = vi.fn(() => ({ tagName: "TEXTAREA" }));
    const target = { closest } as unknown as EventTarget;

    expect(isParentTabSwipeInteractiveTarget(target)).toBe(true);
    expect(closest).toHaveBeenCalledWith(expect.stringContaining("textarea"));
  });

  it("allows non-element targets", () => {
    expect(isParentTabSwipeInteractiveTarget(null)).toBe(false);
    expect(isParentTabSwipeInteractiveTarget({} as EventTarget)).toBe(false);
  });
});
