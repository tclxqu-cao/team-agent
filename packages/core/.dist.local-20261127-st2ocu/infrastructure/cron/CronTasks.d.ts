import type { CronTask } from "../../domain/cron/entities.js";
/**
 * CRUD layer for the scheduled_tasks.json file.
 * Uses synchronous I/O (acceptable for a small JSON config file).
 */
export declare class CronTasks {
    private readonly filePath;
    constructor(baseDir: string);
    getFilePath(): string;
    private ensureDir;
    /** Load tasks from disk. Returns [] on any error. */
    load(): CronTask[];
    /** Persist tasks to disk. */
    save(tasks: CronTask[]): void;
    /**
     * Create a new task and persist it (unless durable=false).
     * Returns the created task (with computed nextFireAt).
     */
    create(input: Omit<CronTask, "id" | "createdAt" | "nextFireAt">): CronTask;
    /** Delete a task by full ID or ID prefix. Returns true if found and removed. */
    delete(id: string): boolean;
    /** Delete all tasks. */
    deleteAll(): void;
    /** Update a task by ID. Returns the updated task or null if not found. */
    update(id: string, patch: Partial<CronTask>): CronTask | null;
    /** List all tasks. */
    list(): CronTask[];
    /** Pause a task (enabled = false). */
    pause(id: string): CronTask | null;
    /** Resume a task (enabled = true) and recompute nextFireAt from now. */
    resume(id: string): CronTask | null;
}
//# sourceMappingURL=CronTasks.d.ts.map