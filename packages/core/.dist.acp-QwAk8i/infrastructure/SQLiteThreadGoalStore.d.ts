import type { IThreadGoalStore, ThreadGoal } from '../domain/goal/ThreadGoal.js';
export declare class SQLiteThreadGoalStore implements IThreadGoalStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(sessionId: string): Promise<ThreadGoal | null>;
    set(goal: ThreadGoal): Promise<void>;
    clear(sessionId: string): Promise<boolean>;
    listActive(): Promise<ThreadGoal[]>;
}
//# sourceMappingURL=SQLiteThreadGoalStore.d.ts.map