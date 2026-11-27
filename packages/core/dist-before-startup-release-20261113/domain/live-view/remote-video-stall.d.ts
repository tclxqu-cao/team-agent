/**
 * Viewer-side watchdog for a real-time video stream whose transport stays
 * connected while frames silently stop arriving (stalled RTP, dead decoder,
 * locked producer). A stalled decision resumes the JPEG fallback instead of
 * keeping redundant JPEG delivery active throughout healthy video playback.
 *
 * This is a domain policy: no WebRTC, browser, or transport types.
 */
export declare const REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS = 5000;
export declare const REMOTE_VIDEO_STALL_TIMEOUT_MS = 10000;
export type RemoteVideoStallState = "streaming" | "stalled";
export interface RemoteVideoStallDecision {
    state: RemoteVideoStallState;
    /** Milliseconds since the baseline instant (stream start or last frame). */
    silentForMs: number;
}
export declare class RemoteVideoStallPolicy {
    private startedAt;
    private lastFrameAt;
    private lastFrameCount;
    /** Marks a (re)negotiated stream: both timeouts measure from here. */
    begin(now: number): void;
    /** Excludes background suspension while preserving the steady-stream grace. */
    resume(now: number): void;
    /**
     * Feeds a decoded/presented frame counter. A positive counter reset after
     * renegotiation is progress; zero never proves that the first frame arrived.
     */
    observe(frameCount: number | undefined, now: number): boolean;
    evaluate(now: number): RemoteVideoStallDecision;
}
//# sourceMappingURL=remote-video-stall.d.ts.map