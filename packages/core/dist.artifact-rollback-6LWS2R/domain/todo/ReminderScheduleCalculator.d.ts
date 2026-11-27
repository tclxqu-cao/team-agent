import { type TodoTrigger } from "./entities";
/** Wall-clock recurrence, independent of the server's timezone. A repeated DST
 * minute fires at its first occurrence; a nonexistent local minute is skipped. */
export declare class ReminderScheduleCalculator {
    next(trigger: TodoTrigger, timeZone: string, afterMs: number): number | null;
    previous(trigger: TodoTrigger, timeZone: string, atOrBeforeMs: number): number | null;
    private calculate;
}
//# sourceMappingURL=ReminderScheduleCalculator.d.ts.map