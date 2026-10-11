/**
 * Viewer-side watchdog for a real-time video stream whose transport stays
 * connected while frames silently stop arriving (stalled RTP, dead decoder,
 * locked producer). The JPEG fallback keeps flowing underneath the video
 * surface, so the decision only needs to say when that fallback must be
 * revealed instead of a black picture.
 *
 * This is a domain policy: no WebRTC, browser, or transport types.
 */
export const REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS = 5_000;
export const REMOTE_VIDEO_STALL_TIMEOUT_MS = 10_000;

export type RemoteVideoStallState = "streaming" | "stalled";

export interface RemoteVideoStallDecision {
  state: RemoteVideoStallState;
  /** Milliseconds since the baseline instant (stream start or last frame). */
  silentForMs: number;
}

export class RemoteVideoStallPolicy {
  private startedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private lastFrameCount: number | null = null;

  /** Marks a (re)negotiated stream: both timeouts measure from here. */
  begin(now: number): void {
    this.startedAt = now;
    this.lastFrameAt = null;
    this.lastFrameCount = null;
  }

  /** Excludes background suspension while preserving the steady-stream grace. */
  resume(now: number): void {
    if (this.startedAt !== null) this.startedAt = now;
    if (this.lastFrameAt !== null) this.lastFrameAt = now;
  }

  /**
   * Feeds a decoded/presented frame counter. A positive counter reset after
   * renegotiation is progress; zero never proves that the first frame arrived.
   */
  observe(frameCount: number | undefined, now: number): boolean {
    if (typeof frameCount !== "number" || !Number.isFinite(frameCount) || frameCount < 0) return false;
    if (frameCount === this.lastFrameCount) return false;
    this.lastFrameCount = frameCount;
    if (frameCount === 0) return false;
    this.lastFrameAt = now;
    return true;
  }

  evaluate(now: number): RemoteVideoStallDecision {
    const reference = this.lastFrameAt ?? this.startedAt;
    if (reference === null) return { state: "streaming", silentForMs: 0 };
    const silentForMs = Math.max(0, now - reference);
    const timeout = this.lastFrameAt === null
      ? REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS
      : REMOTE_VIDEO_STALL_TIMEOUT_MS;
    return { state: silentForMs >= timeout ? "stalled" : "streaming", silentForMs };
  }
}
