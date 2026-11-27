/** Opaque packet values keep RTP, sockets and clocks outside the domain. */
export interface RemoteVideoRepair<T> {
    readonly sequence: number;
    readonly bytes: number;
    readonly expiresAt: number;
    readonly value: T;
    readonly generation: number;
}
export type RemoteVideoRepairRequest<T> = {
    action: 'repair';
    entry: RemoteVideoRepair<T>;
} | {
    action: 'ignore' | 'recover';
};
/** Bounded recovery within the latest independently decodable video generation. */
export declare class RemoteVideoRecoveryHistory<T> {
    readonly maxBytes: number;
    readonly maxPackets = 8192;
    readonly maxAgeMs = 2000;
    readonly maxAttempts = 3;
    private entries;
    private bytes;
    private rttMs;
    private latestSequence;
    private sequenceSpan;
    private needsKeyframe;
    private nextPruneAt;
    private generation;
    setRtt(rttMs: number): void;
    record(packet: {
        sequence: number;
        bytes: number;
        value: T;
        frameDeadline: number;
        keyFrameStart: boolean;
    }, now: number): void;
    request(sequence: number, now: number): RemoteVideoRepairRequest<T>;
    beginRepair(packet: RemoteVideoRepair<T>, now: number): 'send' | 'ignore' | 'recover';
    reset(needsKeyframe?: boolean): void;
    snapshot(now: number): {
        historyBytes: number;
        historyPackets: number;
        awaitingRecoveryKeyframe: boolean;
    };
    private prune;
    private remove;
    private validSequence;
}
//# sourceMappingURL=remote-video-recovery.d.ts.map