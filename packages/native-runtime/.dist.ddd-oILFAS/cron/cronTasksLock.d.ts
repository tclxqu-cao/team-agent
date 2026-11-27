/**
 * Advisory PID-based lock file.
 * Ensures only one process acts as the cron scheduler in multi-instance setups.
 * Lock file: .agents/.scheduler.lock (sibling of scheduled_tasks.json).
 */
export declare class CronTasksLock {
    private readonly lockPath;
    private _acquired;
    constructor(tasksFilePath: string);
    get acquired(): boolean;
    /**
     * Try to acquire the scheduler lock.
     * Returns true if this process now owns the lock.
     */
    tryAcquire(): boolean;
    release(): void;
}
//# sourceMappingURL=cronTasksLock.d.ts.map