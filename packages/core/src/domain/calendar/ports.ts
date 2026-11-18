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

export const EMPTY_RESULT: CalendarSourceResult = { entries: [], groups: [] };

export function sourceError(source: CalendarSourceId, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${source}: ${message}`.slice(0, 240);
}