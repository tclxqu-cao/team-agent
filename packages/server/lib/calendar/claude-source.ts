import type { CalendarRange, CalendarSourceResult } from "@agent/core";
/** Claude session tasks and Skill files are not registered schedules. */
export async function readClaudeSource(_range: CalendarRange, _claudeHome: string): Promise<CalendarSourceResult> {
  return { entries: [], groups: [], unscheduledSchedules: [] };
}
