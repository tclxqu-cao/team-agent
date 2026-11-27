/** Byte budgets and latency limits for a remote-video sender. Time is supplied by a clock port. */
export declare class RemoteVideoPacingPolicy {
    readonly maxPacketBytes = 1500;
    readonly maxQueuedBytes: number;
    readonly maxQueuedFrames = 8;
    readonly maxQueueAgeMs = 250;
    readonly maxQueuedRepairBytes: number;
    readonly maxQueuedRepairs = 256;
    private rate;
    private credit;
    private repairCredit;
    private repairRate?;
    private updatedAt;
    private needsKeyframe;
    constructor({ bitRate, now }?: {
        bitRate?: number;
        now?: number;
    });
    get pacingBitRate(): number;
    get waitingForKeyframe(): boolean;
    private get bytesPerMs();
    private get burstBytes();
    private get repairBytesPerMs();
    private get repairBurstBytes();
    setBitRate(bitRate: number, now: number): void;
    reset(now: number): void;
    setRepairBitRate(bitRate: number, now: number): void;
    requireKeyframe(): void;
    acceptFrame(keyFrame: boolean): boolean;
    delayFor(bytes: number, now: number): number;
    consume(bytes: number, now: number): boolean;
    delayForRepair(bytes: number, now: number): number;
    consumeRepair(bytes: number, now: number): boolean;
    overloaded({ bytes, frames, ageMs }: {
        bytes: number;
        frames: number;
        ageMs: number;
    }): boolean;
    frameLifetimeMs(bytes: number, keyFrame: boolean): number;
    private validPacket;
    private refill;
}
//# sourceMappingURL=remote-video-pacing.d.ts.map