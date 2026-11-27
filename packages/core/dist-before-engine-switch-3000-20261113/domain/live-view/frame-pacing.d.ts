/**
 * Adaptive send-rate policy for live-view screencast adapters.
 *
 * One shared policy backs every frame source (desktop capture, CDP pull,
 * ego push): a rejected frame or a send that overshoots the 500 ms budget
 * steps the target rate down (floor 2 FPS), and a streak of fast frames
 * steps it back up toward the adapter's cap (≤10 FPS). Adapters keep their
 * capture mechanics; the pacing decision must not drift between them.
 */
export declare class LiveViewFramePacer {
    #private;
    readonly maxFps: number;
    targetFps: number;
    constructor({ fps }?: {
        fps?: number;
    });
    /** Minimum forward interval (ms) enforcing the current target rate. */
    get minIntervalMs(): number;
    /** Record one send outcome: downgrade on backpressure or an over-budget send. */
    recordSend(result: {
        accepted?: boolean;
    } | void | null, durationMs: number): void;
}
//# sourceMappingURL=frame-pacing.d.ts.map