import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CronTask, ScheduledTasksFile } from "./entities.js";
import { computeNextFireAt } from "./cronParser.js";

/**
 * CRUD layer for the scheduled_tasks.json file.
 * Uses synchronous I/O (acceptable for a small JSON config file).
 */
export class CronTasks {
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = join(baseDir, ".agents", "scheduled_tasks.json");
  }

  getFilePath(): string { return this.filePath; }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Load tasks from disk. Returns [] on any error. */
  load(): CronTask[] {
    this.ensureDir();
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as ScheduledTasksFile;
      return Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      return [];
    }
  }

  /** Persist tasks to disk. */
  save(tasks: CronTask[]): void {
    this.ensureDir();
    const file: ScheduledTasksFile = { tasks };
    writeFileSync(this.filePath, JSON.stringify(file, null, 2), "utf-8");
  }

  /**
   * Create a new task and persist it (unless durable=false).
   * Returns the created task (with computed nextFireAt).
   */
  create(input: Omit<CronTask, "id" | "createdAt" | "nextFireAt">): CronTask {
    const task: CronTask = {
      ...input,
      id: crypto.randomUUID().slice(0, 8),
      createdAt: Date.now(),
      nextFireAt: computeNextFireAt(input.cron, Date.now()),
    };
    if (task.durable !== false) {
      const tasks = this.load();
      tasks.push(task);
      this.save(tasks);
    }
    return task;
  }

  /** Delete a task by full ID or ID prefix. Returns true if found and removed. */
  delete(id: string): boolean {
    const tasks = this.load();
    const idx = tasks.findIndex(t => t.id === id || t.id.startsWith(id));
    if (idx === -1) return false;
    tasks.splice(idx, 1);
    this.save(tasks);
    return true;
  }

  /** Delete all tasks. */
  deleteAll(): void {
    this.save([]);
  }

  /** Update a task by ID. Returns the updated task or null if not found. */
  update(id: string, patch: Partial<CronTask>): CronTask | null {
    const tasks = this.load();
    const idx = tasks.findIndex(t => t.id === id || t.id.startsWith(id));
    if (idx === -1) return null;
    tasks[idx] = { ...tasks[idx], ...patch };
    this.save(tasks);
    return tasks[idx];
  }

  /** List all tasks. */
  list(): CronTask[] {
    return this.load();
  }

  /** Pause a task (enabled = false). */
  pause(id: string): CronTask | null {
    return this.update(id, { enabled: false });
  }

  /** Resume a task (enabled = true) and recompute nextFireAt from now. */
  resume(id: string): CronTask | null {
    const tasks = this.load();
    const task = tasks.find(t => t.id === id || t.id.startsWith(id));
    if (!task) return null;
    return this.update(task.id, {
      enabled: true,
      nextFireAt: computeNextFireAt(task.cron, Date.now()),
    });
  }
}
