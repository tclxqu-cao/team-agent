/**
 * Adaptive send-rate policy for live-view screencast adapters.
 *
 * One shared policy backs every frame source (desktop capture, CDP pull,
 * ego push): a rejected frame or a send that overshoots the 500 ms budget
 * steps the target rate down (floor 2 FPS), and a streak of fast frames
 * steps it back up toward the adapter's cap. Adapters keep their capture
 * mechanics; the pacing decision must not drift between them.
 */
export class LiveViewFramePacer {
  readonly maxFps: number;
  targetFps: number;
  #fastFrameStreak = 0;

  constructor({ fps = 5 }: { fps?: number } = {}) {
    this.maxFps = Math.max(2, Math.min(5, fps));
    this.targetFps = this.maxFps;
  }

  /** Minimum forward interval (ms) enforcing the current target rate. */
  get minIntervalMs(): number {
    return 1_000 / this.targetFps;
  }

  /** Record one send outcome: downgrade on backpressure or an over-budget send. */
  recordSend(result: { accepted?: boolean } | void | null, durationMs: number): void {
    if (result?.accepted === false || durationMs > 500) {
      this.targetFps = Math.max(2, this.targetFps - 1);
      this.#fastFrameStreak = 0;
      return;
    }
    this.#fastFrameStreak += 1;
    if (this.targetFps < this.maxFps && this.#fastFrameStreak >= this.targetFps * 2) {
      this.targetFps += 1;
      this.#fastFrameStreak = 0;
    }
  }
}
