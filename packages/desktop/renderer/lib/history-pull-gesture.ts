interface TouchPoint { clientX: number; clientY: number }

/** One older-page request per downward gesture near the history's top edge. */
export class HistoryPullGesture {
  private origin: TouchPoint | null = null;

  start(touches: ArrayLike<TouchPoint>): void {
    this.origin = touches.length === 1 ? { clientX: touches[0].clientX, clientY: touches[0].clientY } : null;
  }

  reset(): void { this.origin = null; }

  move(touches: ArrayLike<TouchPoint>, scrollTop: number): boolean {
    if (touches.length !== 1) { this.reset(); return false; }
    if (!this.origin) return false;
    const dx = touches[0].clientX - this.origin.clientX;
    const dy = touches[0].clientY - this.origin.clientY;
    if (dy < 48 || Math.abs(dx) >= dy || scrollTop > 240) return false;
    this.reset();
    return true;
  }
}
