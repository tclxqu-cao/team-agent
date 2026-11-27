export declare class RemoteFrameQoe {
    private frames;
    private receipts;
    private clock?;
    private samples;
    sent(rtp: number, sentAt: number, capturedAt?: number): void;
    synchronize(t0: number, t1: number, t2: number, t3: number): boolean;
    presented(rtp: number, presentedAt: number, receivedAt: number): boolean;
    snapshot(): {
        presentedFrames: number;
        feedbackP95Ms: number | undefined;
        captureToPresentationP95Ms: number | undefined;
        clockUncertaintyMs: number | undefined;
    };
}
//# sourceMappingURL=remote-frame-qoe.d.ts.map