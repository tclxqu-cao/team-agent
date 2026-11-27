import type { IToolExecutor, ToolContext, ToolResult } from "./entities.js";
/** Pre-image of a single workspace file. */
export interface FileSnapshot {
    path: string;
    /** false = the file did not exist before the tool ran (undo removes it). */
    existed: boolean;
    /** null when existed is false. */
    content: string | null;
}
export interface CheckpointBatch {
    snapshots: FileSnapshot[];
}
/** Storage boundary for checkpoint batches (DDD: executor depends on this interface). */
export interface IFileCheckpointJournal {
    /** Start a new undo batch; subsequent snapshots land in it. */
    beginBatch(): void;
    /** Snapshot a file's pre-image into the current batch (best effort). */
    snapshot(path: string): Promise<void>;
    /** Restore and drop the most recent batch; returns restored paths, or null when empty. */
    undoLastBatch(): Promise<string[] | null>;
    /** Number of undoable batches. */
    batchCount(): number;
}
/** In-memory undo journal with bounded snapshot size. */
export declare class InMemoryFileCheckpointJournal implements IFileCheckpointJournal {
    private readonly batches;
    private totalBytes;
    beginBatch(): void;
    snapshot(path: string): Promise<void>;
    undoLastBatch(): Promise<string[] | null>;
    batchCount(): number;
    private push;
    private dropOldest;
}
/**
 * Decorator that snapshots workspace files before write tools run, enabling
 * turn-scoped undo. Composes like PermissionAwareToolExecutor: it wraps any
 * IToolExecutor and forwards everything it does not intercept.
 */
export declare class CheckpointAwareToolExecutor implements IToolExecutor {
    private readonly delegate;
    private readonly journal;
    constructor(delegate: IToolExecutor, journal: IFileCheckpointJournal);
    validate(name: string, args: Record<string, unknown>): boolean;
    getAuthorizationPolicy(name: string): import("./entities.js").ToolAuthorizationPolicy;
    getNetworkAccess(name: string): import("./entities.js").ToolNetworkAccess;
    execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=checkpoints.d.ts.map