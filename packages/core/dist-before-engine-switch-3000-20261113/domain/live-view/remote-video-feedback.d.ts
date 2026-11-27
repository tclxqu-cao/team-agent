/** Qualifies transport estimates without mistaking sparse desktop traffic for a capacity limit. */
export declare class RemoteVideoFeedbackPolicy {
    private previous?;
    observe(sample: {
        availableBitrate: number;
        sentBytes: number;
        targetBitRate: number;
        queueDelayMs: number;
        congested: boolean;
    }, now: number): {
        availableOutgoingBitrate: number;
        applicationLimited: boolean;
        congested: boolean;
    } | null;
    reset(): void;
}
//# sourceMappingURL=remote-video-feedback.d.ts.map