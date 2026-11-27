import { type CompoundFrameIdentity, type CompoundDirtyRect } from "./remote-compound-video.js";
export interface CompoundScrollCopy {
    sourceRevision: number;
    sourceX: number;
    sourceY: number;
    x: number;
    y: number;
    width: number;
    height: number;
}
export declare function isCompoundScrollCopy(copy: CompoundScrollCopy, frame: Pick<CompoundFrameIdentity, "width" | "height">): boolean;
/** Tracks repair debt independently of compressed-image/cache identities. */
export declare class RemoteCompoundQualityPolicy {
    private frame;
    private debt;
    private priorSharp;
    private priorRevision;
    private point?;
    private interactionAt;
    private activity;
    invalidate(frame: CompoundFrameIdentity, rects: readonly CompoundDirtyRect[] | undefined, now: number): void;
    noteInteraction(point: {
        x: number;
        y: number;
    } | undefined, now: number): void;
    observe(activity: string | undefined): void;
    entropyLimit(now: number): number;
    priorities(now: number, count?: number, inFlight?: readonly {
        x: number;
        y: number;
    }[]): number[];
    attempted(indices: readonly number[], now: number): void;
    acknowledge(tiles: readonly {
        x: number;
        y: number;
    }[]): void;
    acknowledgeScroll(copy: CompoundScrollCopy): {
        x: number;
        y: number;
    }[];
    isSharp(tile: {
        x: number;
        y: number;
    }): boolean;
    snapshot(): {
        repairBlocks: number;
        sharpBlocks: number;
    };
}
export declare function compoundWindowLimits(enabled: boolean, rttMs?: number): {
    batches: number;
    bytes: number;
};
//# sourceMappingURL=remote-compound-quality.d.ts.map