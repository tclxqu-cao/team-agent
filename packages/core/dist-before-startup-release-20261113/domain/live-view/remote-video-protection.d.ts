import type { RemoteVideoNetworkTelemetry, RemoteVideoSenderTelemetry } from './remote-video-types.js';
/** Allocates actual recovery cost before the nominal media budget is split into video and patches. */
export declare class RemoteVideoProtectionPolicy {
    private previous?;
    private repairFraction;
    private reservedBitRate;
    seed(sender: Pick<RemoteVideoSenderTelemetry, 'sentBytes' | 'repairedBytes'>, now: number): void;
    observe(sender: Partial<RemoteVideoSenderTelemetry> | undefined, network: RemoteVideoNetworkTelemetry, now: number): void;
    allocation(totalBitRate: number): {
        videoBitRate: number;
        reservedBitRate: number;
        repairBitRate: number;
    };
    reset(): void;
}
//# sourceMappingURL=remote-video-protection.d.ts.map