export type CalendarSourceId = "customer-agent" | "codex" | "claude" | "workbuddy" | "zcode" | "opencode" | "deepseek";
export declare const CALENDAR_SOURCES: readonly CalendarSourceId[];
export declare const CALENDAR_SOURCE_LABELS: Record<CalendarSourceId, string>;
export type CalendarEntryKind = "cron" | "run" | "reminder" | "due" | "todo";
export type CalendarEntryState = "upcoming" | "paused" | "completed" | "failed" | "overdue" | "pending" | "in-progress" | "unscheduled";
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
export declare function localDateKey(ms: number): string;
export declare function todoState(status: string, dueAt: number | undefined, nowMs: number): CalendarEntryState;
//# sourceMappingURL=entities.d.ts.map