// ── Calendar Domain ──
// Read-only schedules, runs, and independent Todo dates/reminders. Session plans are excluded.

export type CalendarSourceId =
  | "customer-agent"
  | "codex"
  | "claude"
  | "workbuddy"
  | "zcode"
  | "opencode"
  | "deepseek";

export const CALENDAR_SOURCES: readonly CalendarSourceId[] = [
  "customer-agent", "codex", "claude", "workbuddy", "zcode", "opencode", "deepseek",
];

export const CALENDAR_SOURCE_LABELS: Record<CalendarSourceId, string> = {
  "customer-agent": "AgentRoam",
  codex: "Codex",
  claude: "Claude Code",
  workbuddy: "WorkBuddy",
  zcode: "ZCode",
  opencode: "OpenCode",
  deepseek: "DeepSeek",
};

export type CalendarEntryKind = "cron" | "run" | "reminder" | "due" | "todo";

export type CalendarEntryState =
  | "upcoming"
  | "paused"
  | "completed"
  | "failed"
  | "overdue"
  | "pending"
  | "in-progress"
  | "unscheduled";

export interface CalendarEntry {
  taskId?: string;
  scheduleRef?: string;
  id: string;
  kind: CalendarEntryKind;
  source: CalendarSourceId;
  executionAgentType?: string;
  title: string;
  /** Placement timestamp (UTC ms). */
  at: number;
  state: CalendarEntryState;
  detail?: string;
  scheduleLabel?: string;
  sessionId?: string;
  sessionTitle?: string;
  cwd?: string;
  recurring?: boolean;
  dueAt?: number;
  scheduleId?: string;
  scheduledAt?: number;
  executedAt?: number;
}

export interface CalendarTodoGroup {
  id: string;
  source: CalendarSourceId;
  title: string;
  cwd?: string;
  updatedAt?: number;
  todos: CalendarEntry[];
}

export interface CalendarSourceStatus {
  ok: boolean;
  error?: string;
  entries: number;
  todos: number;
}

export interface CalendarOverview {
  /** Inclusive local-date bounds, YYYY-MM-DD. */
  from: string;
  to: string;
  generatedAt: number;
  /** Dated entries keyed by local YYYY-MM-DD. */
  days: Record<string, CalendarEntry[]>;
  /** Todos without a deadline, grouped by owning session. */
  unscheduled: CalendarTodoGroup[];
  /** Schedule definitions with no on-disk recurrence rule (e.g. Claude skills). */
  unscheduledSchedules: CalendarEntry[];
  sources: Record<CalendarSourceId, CalendarSourceStatus>;
}

export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function todoState(status: string, dueAt: number | undefined, nowMs: number): CalendarEntryState {
  if (status === "completed") return "completed";
  if (status === "in-progress" || status === "in_progress") return "in-progress";
  if (dueAt !== undefined && dueAt < nowMs) return "overdue";
  return "pending";
}
