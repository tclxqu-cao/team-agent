import type { RemoteVideoQuality, RemoteVideoReceiverTelemetry } from './remote-video-types.js';
/** Receiver CPU/display pressure is independent of link congestion and source activity. */
export declare class RemoteVideoReceiverPolicy {
    maxFps: number;
    maxEdge?: number;
    private sequence;
    private lastSampleAt;
    private sizeAt;
    private pressure;
    private healthy;
    private scale;
    private latencyPressure;
    private sourceEdge;
    reset(): void;
    observe(sample: RemoteVideoReceiverTelemetry | undefined, quality: RemoteVideoQuality, fps: number, now: number): boolean;
}
//# sourceMappingURL=remote-video-receiver.d.ts.map