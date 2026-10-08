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

  /**
   * Feeds the receiver's monotonic decoded-frame counter. Any change counts as
   * progress — a counter reset (codec renegotiation) is activity, not silence.
   */
  observe(frameCount: number | undefined, now: number): void {
    if (typeof frameCount !== "number" || !Number.isFinite(frameCount)) return;
    if (this.lastFrameCount !== null && frameCount === this.lastFrameCount) return;
    this.lastFrameCount = frameCount;
    this.lastFrameAt = now;
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
