export interface TouchPoint { x: number; y: number }

/** A tap is committed only after release; any drag or multi-touch cancels it. */
export class BrowserLiveTouch {
  private points = new Map<number, TouchPoint>();
  private origin: TouchPoint | null = null;
  private moved = false;

  reset() { this.points.clear(); this.origin = null; this.moved = false; }

  down(id: number, point: TouchPoint) {
    if (!this.points.size) { this.origin = point; this.moved = false; }
    this.points.set(id, point);
    if (this.points.size > 1) this.moved = true;
  }

  move(id: number, point: TouchPoint) {
    const previous = this.points.get(id);
    if (!previous) return null;
    const before = [...this.points.values()];
    this.points.set(id, point);
    if (this.origin && Math.hypot(point.x - this.origin.x, point.y - this.origin.y) > 8) this.moved = true;
    if (this.points.size === 1) {
      return this.moved ? { scale: 1, from: previous, to: point } : null;
    }
    const after = [...this.points.values()];
    const midpoint = (p: TouchPoint[]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
    const distance = (p: TouchPoint[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    const oldDistance = distance(before);
    return { scale: oldDistance > 0 ? distance(after) / oldDistance : 1, from: midpoint(before), to: midpoint(after) };
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
}
