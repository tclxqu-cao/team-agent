export interface TouchPoint { x: number; y: number }

export interface TouchMovement {
  scale: number;
  /** Cumulative pinch ratio since the gesture began (1 = unchanged distance). */
  distanceRatio: number;
  from: TouchPoint;
  to: TouchPoint;
  /** Fingers currently down — two means the drag may scroll the remote view. */
  pointers: number;
}

/** A tap is committed only after release; any drag or multi-touch cancels it. */
export class BrowserLiveTouch {
  private points = new Map<number, TouchPoint>();
  private origin: TouchPoint | null = null;
  private originDistance = 0;
  private moved = false;

  reset() { this.points.clear(); this.origin = null; this.originDistance = 0; this.moved = false; }

  down(id: number, point: TouchPoint) {
    if (!this.points.size) { this.origin = point; this.moved = false; }
    this.points.set(id, point);
    if (this.points.size > 1) this.moved = true;
    this.originDistance = this.#currentDistance();
  }

  move(id: number, point: TouchPoint): TouchMovement | null {
    const previous = this.points.get(id);
    if (!previous) return null;
    const before = [...this.points.values()];
    this.points.set(id, point);
    if (this.origin && Math.hypot(point.x - this.origin.x, point.y - this.origin.y) > 8) this.moved = true;
    if (this.points.size === 1) {
      return this.moved ? { scale: 1, distanceRatio: 1, from: previous, to: point, pointers: 1 } : null;
    }
    const after = [...this.points.values()];
    const midpoint = (p: TouchPoint[]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
    const distance = (p: TouchPoint[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    const oldDistance = distance(before);
    // The ratio against the gesture-start distance is what separates a real
    // pinch from translation noise: finger jitter makes the per-move scale
    // differ from 1 by a few ‰, which must not swallow a two-finger scroll.
    const ratio = this.originDistance > 0 ? distance(after) / this.originDistance : 1;
    return {
      scale: oldDistance > 0 ? distance(after) / oldDistance : 1,
      distanceRatio: ratio,
      from: midpoint(before),
      to: midpoint(after),
      pointers: this.points.size,
    };
  }

  up(id: number, point: TouchPoint, cancelled = false) {
    if (!this.points.has(id)) return false;
    const tap = !cancelled && !this.moved && this.points.size === 1 && !!this.origin
      && Math.hypot(point.x - this.origin.x, point.y - this.origin.y) <= 8;
    this.points.delete(id);
    if (cancelled) this.moved = true;
    if (!this.points.size) this.reset();
    return tap;
  }

  #currentDistance(): number {
    const list = [...this.points.values()];
    return list.length >= 2
      ? Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y)
      : 0;
  }
}
