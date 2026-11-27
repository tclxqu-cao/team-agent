import type { ParallelSessionGroup, ParallelSessionIdentity } from "../domain/session/ParallelSessions.js";
export declare class SQLiteParallelSessionStore<T extends ParallelSessionIdentity> {
    private readonly database;
    constructor(baseDir: string);
    create(group: ParallelSessionGroup<T>): void;
    getForSession(sessionId: string): ParallelSessionGroup<T> | null;
}
//# sourceMappingURL=SQLiteParallelSessionStore.d.ts.map