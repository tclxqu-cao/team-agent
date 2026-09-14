import { describe, expect, it } from 'vitest';
import { HistoryPullGesture } from './history-pull-gesture';
const point = (clientX: number, clientY: number) => ({ clientX, clientY });
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
