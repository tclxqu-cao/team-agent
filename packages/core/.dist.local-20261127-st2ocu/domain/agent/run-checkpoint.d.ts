import type { Message } from '../model/entities.js';
/** One store belongs to one logical run, not to every turn in a session. */
export interface RunCheckpoint {
    schema: 1;
    sessionId: string;
    input: string;
    workingDirectory: string;
    messages: Message[];
    iteration: number;
    phase: 'ready' | 'tools_pending' | 'completed';
    pendingToolIds: string[];
    finalText?: string;
}
export interface IRunCheckpointStore {
    load(): Promise<RunCheckpoint | null>;
    save(checkpoint: RunCheckpoint): Promise<void>;
}
export declare function validateRunCheckpoint(value: unknown): asserts value is RunCheckpoint;
//# sourceMappingURL=run-checkpoint.d.ts.map