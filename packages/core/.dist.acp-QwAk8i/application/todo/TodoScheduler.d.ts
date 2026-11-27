import { type TodoExecution } from "../../domain/todo/entities";
import type { ITodoUnitOfWork } from "../../domain/todo/ports";
import { ReminderScheduleCalculator } from "../../domain/todo/ReminderScheduleCalculator";
export declare class TodoScheduler {
    private readonly uow;
    private readonly calculator;
    constructor(uow: ITodoUnitOfWork, calculator?: ReminderScheduleCalculator);
    tick(now: number): {
        reminded: number;
        queued: number;
        missed: number;
        skipped: number;
    };
}
/** A business success report is only a candidate. The authoritative runtime
 * must also complete successfully before the Todo can be checked off. */
export declare class TodoExecutionService {
    private readonly uow;
    private readonly clock;
    constructor(uow: ITodoUnitOfWork, clock?: () => number);
    pending(): TodoExecution[];
    bind(ownerId: string, executionId: string, sessionId: string, runId?: string): TodoExecution;
    report(ownerId: string, executionId: string, runId: string, requestId: string, outcome: "progress" | "succeeded" | "failed", summary: string): import("../..").TodoExecutionReport;
    settle(ownerId: string, executionId: string, runtimeStatus: "completed" | "failed" | "cancelled" | "interrupted", error?: string): TodoExecution;
}
//# sourceMappingURL=TodoScheduler.d.ts.map