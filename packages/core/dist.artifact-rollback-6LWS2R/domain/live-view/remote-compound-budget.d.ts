import type { RemoteVideoObservation } from "./remote-video-types.js";
export interface CompoundBitRateAllocation {
    videoBitRate: number;
    patchBytesPerSecond: number;
}
/** Demand is measured at the wire port; policy is independent of codecs and clocks. */
export declare class RemoteCompoundBudgetPolicy {
    private demandBits;
    private demandAt;
    private observation;
    private observedAt;
    noteDemand(bytes: number, now: number): void;
    observe(observation: RemoteVideoObservation, now: number): void;
    allocation(bitRate: number, enabled: boolean, now: number): CompoundBitRateAllocation;
}
//# sourceMappingURL=remote-compound-budget.d.ts.map