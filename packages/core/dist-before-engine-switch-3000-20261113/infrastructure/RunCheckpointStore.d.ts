import { type IRunCheckpointStore, type RunCheckpoint } from '../domain/agent/run-checkpoint.js';
/** Atomic replacement: a process crash leaves either the old or the new checkpoint. */
export declare class FileRunCheckpointStore implements IRunCheckpointStore {
    private readonly file;
    constructor(file: string);
    load(): Promise<RunCheckpoint | null>;
    save(checkpoint: RunCheckpoint): Promise<void>;
}
//# sourceMappingURL=RunCheckpointStore.d.ts.map