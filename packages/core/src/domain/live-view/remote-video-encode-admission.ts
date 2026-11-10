/** Native adapters execute these limits; intentional coalescing is not an encode failure. */
export function remoteVideoEncodeAdmission(maxFps: number): { maxPendingFrames: number } {
  return { maxPendingFrames: Number.isFinite(maxFps) && maxFps >= 20 ? 2 : 1 };
}

/** Longer healthy GOPs avoid frequent IDR bursts; recovery remains PLI driven. */
export function remoteVideoKeyframeInterval(maxFps: number, reason = "steady"): number {
  const fps = Number.isFinite(maxFps) ? Math.max(5, Math.min(30, Math.floor(maxFps))) : 30;
  return Math.max(5, Math.min(120, fps * (/pressure|congest|loss/.test(reason) ? 1 : fps <= 5 ? 4 : 2)));
}
