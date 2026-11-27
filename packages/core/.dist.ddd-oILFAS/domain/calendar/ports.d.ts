import type { CalendarEntry, CalendarSourceId, CalendarTodoGroup } from "./entities";
export interface CalendarRange {
    fromMs: number;
    toMs: number;
    nowMs: number;
}
export interface CalendarSourceResult {
    entries: CalendarEntry[];
    groups: CalendarTodoGroup[];
    unscheduledSchedules?: CalendarEntry[];
}
export type CalendarSourceReader = (range: CalendarRange) => Promise<CalendarSourceResult>;
export declare const EMPTY_RESULT: CalendarSourceResult;
export declare function sourceError(source: CalendarSourceId, error: unknown): string;
//# sourceMappingURL=ports.d.ts.map