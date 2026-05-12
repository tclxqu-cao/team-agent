import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CronLockEntry {
  taskId: string;
  sessionId: string;
  /** Optional: the agent definition ID that owns this lock (used for re-acquisition) */
  agentId?: string;
  acquiredAt: number;
}

// ── CronTaskLock ───────────────────────────────────────────────────────────

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
export class CronTaskLock {
  private readonly lockDir: string;

  constructor(baseDir: string) {
    this.lockDir = join(baseDir, ".agents", "locks");
  }

  private ensureDir(): void {
    if (!existsSync(this.lockDir)) mkdirSync(this.lockDir, { recursive: true });
  }

  private lockPath(taskId: string): string {
    return join(this.lockDir, `${taskId}.lock`);
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  /** Return the lock entry for a task, or null if none. */
  get(taskId: string): CronLockEntry | null {
    const path = this.lockPath(taskId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as CronLockEntry;
    } catch {
      return null;
    }
  }

  /** Return all lock entries currently on disk. */
  list(): CronLockEntry[] {
    this.ensureDir();
    try {
      return readdirSync(this.lockDir)
        .filter((f) => f.endsWith(".lock"))
        .flatMap((f) => {
          try {
            return [JSON.parse(readFileSync(join(this.lockDir, f), "utf-8")) as CronLockEntry];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  // ── Write ────────────────────────────────────────────────────────────────

  /**
   * Acquire (or overwrite) the lock for `taskId` with the given session.
   * Always succeeds — callers should check `get()` first if they want
   * to avoid overwriting an existing live lock.
   */
  acquire(taskId: string, sessionId: string, agentId?: string): CronLockEntry {
    this.ensureDir();
    const entry: CronLockEntry = { taskId, sessionId, agentId, acquiredAt: Date.now() };
    writeFileSync(this.lockPath(taskId), JSON.stringify(entry, null, 2), "utf-8");
    return entry;
  }

  /** Release the lock for a specific task. */
  release(taskId: string): void {
    const path = this.lockPath(taskId);
    if (existsSync(path)) {
      try { unlinkSync(path); } catch {}
    }
  }

  /**
   * Release ALL locks held by `sessionId`.
   * Returns the list of taskIds whose locks were removed.
   */
  releaseBySession(sessionId: string): string[] {
    const released: string[] = [];
    for (const entry of this.list()) {
      if (entry.sessionId === sessionId) {
        this.release(entry.taskId);
        released.push(entry.taskId);
      }
    }
    return released;
  }

  /**
   * Re-acquire locks for the given taskIds under a new session.
   * agentId is preserved from the old lock if not supplied.
   */
  reacquire(taskIds: string[], newSessionId: string, agentId?: string): void {
    for (const taskId of taskIds) {
      const existing = this.get(taskId);
      this.acquire(taskId, newSessionId, agentId ?? existing?.agentId);
    }
  }
}
