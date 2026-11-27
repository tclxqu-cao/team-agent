/** Browser-compatible enhancement protocol. No codec, transport or DOM dependencies. */
export declare const REMOTE_COMPOUND_VIDEO: Readonly<{
    version: 1;
    channelLabel: "agentroam.compound.v1";
    tileSize: 64;
    maxDimension: 4096;
    maxFramePixels: 8388608;
    maxTileBytes: 32768;
    maxMessageBytes: 48000;
    maxTiles: 128;
    maxCacheEntries: 4096;
    maxCachePixels: 10485760;
    maxEntropy: 24;
    initialEntropy: 6.3;
    sampleIntervalMs: 250;
    acknowledgementTimeoutMs: 2000;
}>;
export interface CompoundFrameIdentity {
    capturedAt?: number;
    epoch: string;
    revision: number;
    timestamp: number;
    width: number;
    height: number;
}
export interface CompoundTileDescriptor {
    key: string;
    x: number;
    y: number;
    width: number;
    height: number;
    entropy: number;
    bytes: number;
}
export interface CompoundDirtyRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export declare function isCompoundDirtyRect(rect: CompoundDirtyRect, frame: Pick<CompoundFrameIdentity, "width" | "height">): boolean;
export interface CompoundTileUpdate extends CompoundTileDescriptor {
    mode: "put" | "reuse";
    cacheId: number;
}
export interface CompoundEncodingCost {
    headerBytes: number;
    tileBytes: number;
    payloadNumerator: number;
    payloadDenominator: number;
}
export interface CompoundUpdatePlan {
    frame: CompoundFrameIdentity;
    tiles: readonly CompoundTileUpdate[];
    estimatedBytes: number;
    resetRequired: boolean;
}
export declare function isCompoundFrame(value: CompoundFrameIdentity): boolean;
export declare function isCompoundTile(tile: CompoundTileDescriptor, frame: CompoundFrameIdentity): boolean;
export declare function compoundRtpTimestamp(timestamp: number): number;
/** Strictly later within the half-range of a wrapping 32-bit RTP clock. */
export declare function isLaterCompoundRtp(a: number, b: number): boolean;
export declare function splitCompoundVideoBitRate(bitRate: number, enabled: boolean): {
    videoBitRate: number;
    patchBytesPerSecond: number;
};
/** Cache entries become reusable only after the receiver admits the exact plan. */
export declare class RemoteCompoundVideoPolicy {
    private frame;
    private assets;
    private placements;
    private cachePixels;
    private reservedIds;
    invalidate(frame: CompoundFrameIdentity, rects?: readonly CompoundDirtyRect[]): boolean;
    plan(frame: CompoundFrameIdentity, tiles: readonly CompoundTileDescriptor[], byteBudget: number, cost?: CompoundEncodingCost): CompoundUpdatePlan | null;
    acknowledge(plan: CompoundUpdatePlan): boolean;
    /** Sent but unacknowledged slots may exist at the receiver, even after invalidation. */
    markSent(plan: CompoundUpdatePlan): boolean;
    resetCache(): void;
    reset(): void;
    private matches;
}
//# sourceMappingURL=remote-compound-video.d.ts.map