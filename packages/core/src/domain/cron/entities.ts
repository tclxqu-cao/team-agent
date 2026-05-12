// ── Cron Domain ──

export interface CronTask {
  id: string;
  /** Cron expression ("0 9 * * *") or interval shorthand ("5m", "1h", "30s") */
  cron: string;
  prompt: string;
  createdAt: number;
  /** If true, reschedule after each fire; if false, delete after first fire */
  recurring: boolean;
  /** If true, immune to max-age pruning (system/built-in tasks only) */
  permanent?: boolean;
  /** If false, task is in-memory only and not written to disk. Default true. */
  durable?: boolean;
  /** Whether the task is active (true) or paused (false) */
  enabled: boolean;
  /** Session to run the prompt in. If unset, a new session is created on first fire and stored. */
  sessionId?: string;
  /** Optional human-readable label */
  label?: string;
  /** UTC ms timestamp of next scheduled fire */
  nextFireAt?: number;
  /** UTC ms timestamp of last fire */
  lastFiredAt?: number;
}

export interface ScheduledTasksFile {
  tasks: CronTask[];
}
