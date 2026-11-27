import type { IThreadGoalStore, ThreadGoal } from '../domain/goal/ThreadGoal.js';
export declare class FileThreadGoalStore implements IThreadGoalStore {
    private readonly filePath;
    constructor(storeDir: string);
    private readAll;
    private writeAll;
    get(sessionId: string): Promise<ThreadGoal | null>;
    set(goal: ThreadGoal): Promise<void>;
    clear(sessionId: string): Promise<boolean>;
    listActive(): Promise<ThreadGoal[]>;
}
//# sourceMappingURL=FileThreadGoalStore.d.ts.map