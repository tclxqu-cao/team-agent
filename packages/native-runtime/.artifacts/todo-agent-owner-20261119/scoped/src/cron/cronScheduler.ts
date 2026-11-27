import { watch, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CronTask } from "@agent/core";
import { computeNextFireAt } from "@agent/core";
import type { CronTasks } from "@agent/core";
import { CronTasksLock } from "./cronTasksLock.js";

/** How often to check for due tasks (ms). */
const CHECK_INTERVAL_MS = 1_000;

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
export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: ReturnType<typeof watch> | null = null;
  private readonly lock: CronTasksLock;
  private started = false;

  constructor(
    private readonly cronTasks: CronTasks,
    private readonly onFire: FireCallback,
    private readonly onTasksChanged: TasksChangedCallback,
  ) {
    this.lock = new CronTasksLock(cronTasks.getFilePath());
  }

  start(): void {
    if (this.started) return;

    if (!this.lock.tryAcquire()) {
      console.warn("[CronScheduler] Another process holds the scheduler lock — skipping start.");
      return;
    }

    this.started = true;
    this.timer = setInterval(() => { void this.tick(); }, CHECK_INTERVAL_MS);
    this.startFileWatcher();
    console.log(`[CronScheduler] Started (PID=${process.pid})`);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    this.lock.release();
    console.log("[CronScheduler] Stopped.");
  }

  // ── File watcher ──────────────────────────────────────────────────────────
  // Watches the .agents/ directory. When scheduled_tasks.json changes from
  // outside the app (manual edit, another process), reload and broadcast.
  // Replace `watch(dir, ...)` with `chokidar.watch(filePath, {...})` for
  // more robust cross-platform watching if desired.

  private startFileWatcher(): void {
    const filePath = this.cronTasks.getFilePath();
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch {}
    }
    try {
      this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === "scheduled_tasks.json") {
          this.onTasksChanged(this.cronTasks.load());
        }
      });
    } catch (err) {
      console.warn("[CronScheduler] Could not start file watcher:", err);
    }
  }

  // ── Tick ──────────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const now = Date.now();
    const tasks = this.cronTasks.load();
    let changed = false;

    for (const task of tasks) {
      if (!task.enabled) continue;
      if (!task.nextFireAt || task.nextFireAt > now) continue;

      // Fire the task (async callback handled by caller)
      this.onFire(task);

      if (!task.recurring) {
        // One-time task: remove after firing
        this.cronTasks.delete(task.id);
      } else {
        // Recurring: advance to next fire time
        this.cronTasks.update(task.id, {
          nextFireAt: computeNextFireAt(task.cron, now),
          lastFiredAt: now,
        });
      }
      changed = true;
    }

    if (changed) {
      this.onTasksChanged(this.cronTasks.load());
    }
  }
}
