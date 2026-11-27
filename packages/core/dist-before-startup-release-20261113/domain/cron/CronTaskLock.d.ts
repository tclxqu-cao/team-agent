export interface CronLockEntry {
    taskId: string;
    sessionId: string;
    /** Optional: the agent definition ID that owns this lock (used for re-acquisition) */
    agentId?: string;
    acquiredAt: number;
}
/**
 * File-based per-task session lock.
 *
 * Layout:  <baseDir>/.agents/locks/<taskId>.lock  (JSON)
 *
 * Rules
 * ─────
 * • One lock per task.  The holding session receives all task-fired runs.
 * • When the holding session is deleted, call `releaseBySession(sessionId)`.
 *   The caller should then invoke `acquire(taskId, newSessionId, agentId)` for
 *   the chosen replacement session, or leave it unlocked (task will create a
 *   fresh session on next fire).
 */
export declare class CronTaskLock {
    private readonly lockDir;
    constructor(baseDir: string);
    private ensureDir;
    private lockPath;
    /** Return the lock entry for a task, or null if none. */
    get(taskId: string): CronLockEntry | null;
    /** Return all lock entries currently on disk. */
    list(): CronLockEntry[];
    /**
     * Acquire (or overwrite) the lock for `taskId` with the given session.
     * Always succeeds — callers should check `get()` first if they want
     * to avoid overwriting an existing live lock.
     */
    acquire(taskId: string, sessionId: string, agentId?: string): CronLockEntry;
    /** Release the lock for a specific task. */
    release(taskId: string): void;
    /**
     * Release ALL locks held by `sessionId`.
     * Returns the list of taskIds whose locks were removed.
     */
    releaseBySession(sessionId: string): string[];
    /**
     * Re-acquire locks for the given taskIds under a new session.
     * agentId is preserved from the old lock if not supplied.
     */
    reacquire(taskIds: string[], newSessionId: string, agentId?: string): void;
}
//# sourceMappingURL=CronTaskLock.d.ts.map