import { describe, expect, it } from 'vitest';
import { HistoryPullGesture, shouldLoadOlderHistoryFromWheel } from './history-pull-gesture';
const point = (clientX: number, clientY: number) => ({ clientX, clientY });
describe('history wheel input', () => {
  const upward = { deltaX: 0, deltaY: -80, ctrlKey: false };

  it('loads a previous page at a stationary top edge without a scroll event', () => {
    expect(shouldLoadOlderHistoryFromWheel(upward, 0)).toBe(true);
    expect(shouldLoadOlderHistoryFromWheel(upward, -12)).toBe(true);
  });

  it('does not treat downward scrolling, horizontal motion or pinch zoom as an older-page request', () => {
    expect(shouldLoadOlderHistoryFromWheel({ ...upward, deltaY: 80 }, 0)).toBe(false);
    expect(shouldLoadOlderHistoryFromWheel({ ...upward, deltaY: 0 }, 0)).toBe(false);
    expect(shouldLoadOlderHistoryFromWheel({ ...upward, deltaX: 100 }, 0)).toBe(false);
    expect(shouldLoadOlderHistoryFromWheel({ ...upward, ctrlKey: true }, 0)).toBe(false);
  });

  it('loads only near the top and leaves ordinary scrolling farther down alone', () => {
    expect(shouldLoadOlderHistoryFromWheel(upward, 240)).toBe(true);
    expect(shouldLoadOlderHistoryFromWheel(upward, 241)).toBe(false);
  });
});

describe('history pull gesture', () => {
  it('loads at a stationary top edge once per gesture, including Safari overscroll', () => {
    const gesture = new HistoryPullGesture();
    gesture.start([point(100, 100)]);
    expect(gesture.move([point(100, 160)], 0)).toBe(true);
    expect(gesture.move([point(100, 200)], 0)).toBe(false);
    gesture.start([point(100, 100)]);
    expect(gesture.move([point(100, 160)], -12)).toBe(true);
  });
  it('leaves upward, horizontal and below-threshold gestures alone', () => {
    const gesture = new HistoryPullGesture();
    for (const p of [point(100, 40), point(200, 160), point(100, 130)]) {
      gesture.start([point(100, 100)]); expect(gesture.move([p], 0)).toBe(false);
    }
    gesture.start([point(100,100)]); expect(gesture.move([point(100,160)],500)).toBe(false);
  });
  it('does not turn pinch, cancelled or missing starts into history requests', () => {
    const gesture = new HistoryPullGesture();
    expect(gesture.move([point(100,200)],0)).toBe(false);
    gesture.start([point(100,100)]);gesture.move([point(100,120),point(150,120)],0);
    expect(gesture.move([point(100,200)],0)).toBe(false);
    gesture.start([point(100,100)]);gesture.reset();
    expect(gesture.move([point(100,200)],0)).toBe(false);
  });
});
