/** Native adapters execute these limits; intentional coalescing is not an encode failure. */
export declare function remoteVideoEncodeAdmission(maxFps: number): {
    maxPendingFrames: number;
};
/** Longer healthy GOPs avoid frequent IDR bursts; recovery remains PLI driven. */
export declare function remoteVideoKeyframeInterval(maxFps: number, reason?: string): number;
//# sourceMappingURL=remote-video-encode-admission.d.ts.map