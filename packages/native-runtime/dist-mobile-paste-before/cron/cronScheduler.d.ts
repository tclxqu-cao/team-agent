import type { CronTask } from "@agent/core";
import type { CronTasks } from "@agent/core";
type FireCallback = (task: CronTask) => void;
type TasksChangedCallback = (tasks: CronTask[]) => void;
/**
 * CronScheduler
 * ─────────────
 * Polls scheduled_tasks.json every CHECK_INTERVAL_MS (1 s) for tasks whose
 * nextFireAt ≤ now, fires them via onFire(), then reschedules or deletes them.
 *
 * Uses a PID-based lock file so only one process runs the scheduler when
 * multiple app instances are open simultaneously.
 *
 * Watches the .agents/ directory with Node's built-in fs.watch so any
 * out-of-process edits to the JSON file take effect immediately.
 * (Drop-in replacement: swap fs.watch for chokidar.watch if needed.)
 */
export declare class CronScheduler {
    private readonly cronTasks;
    private readonly onFire;
    private readonly onTasksChanged;
    private timer;
    private watcher;
    private readonly lock;
    private started;
    constructor(cronTasks: CronTasks, onFire: FireCallback, onTasksChanged: TasksChangedCallback);
    start(): void;
    stop(): void;
    private startFileWatcher;
    private tick;
}
export {};
//# sourceMappingURL=cronScheduler.d.ts.map