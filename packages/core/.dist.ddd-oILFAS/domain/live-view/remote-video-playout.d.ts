import type { RemoteVideoReceiverTelemetry } from './remote-video-types.js';
/** A bounded target, independent of whether a browser exposes a writable playout control. */
export declare class RemoteVideoPlayoutPolicy {
    private targetMs;
    private sequence;
    private observedAt;
    private healthy;
    observe(sample: RemoteVideoReceiverTelemetry | undefined, jitterMs: number | undefined, now: number): number | undefined;
}
//# sourceMappingURL=remote-video-playout.d.ts.map