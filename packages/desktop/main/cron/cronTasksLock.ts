import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Advisory PID-based lock file.
 * Ensures only one process acts as the cron scheduler in multi-instance setups.
 * Lock file: .agents/.scheduler.lock (sibling of scheduled_tasks.json).
 */
export class CronTasksLock {
  private readonly lockPath: string;
  private _acquired = false;

  constructor(tasksFilePath: string) {
    this.lockPath = tasksFilePath.replace(/scheduled_tasks\.json$/, ".scheduler.lock");
  }

  get acquired(): boolean { return this._acquired; }

  /**
   * Try to acquire the scheduler lock.
   * Returns true if this process now owns the lock.
   */
  tryAcquire(): boolean {
    if (this._acquired) return true;

    if (existsSync(this.lockPath)) {
      try {
        const pid = parseInt(readFileSync(this.lockPath, "utf-8").trim(), 10);
        if (!isNaN(pid) && pid !== process.pid) {
          try {
            process.kill(pid, 0); // signal 0 = check if process is alive
            return false;         // another live process holds the lock
          } catch {
            // Process is dead — stale lock, fall through to take over
          }
        }
      } catch {
        // Cannot read lock file — try to take over
      }
    }

    try {
      const dir = dirname(this.lockPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.lockPath, String(process.pid), "utf-8");
      this._acquired = true;
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    if (!this._acquired) return;
    try { unlinkSync(this.lockPath); } catch {}
    this._acquired = false;
  }
}
