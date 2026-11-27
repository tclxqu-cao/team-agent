import { type TodoDetail } from "../../domain/todo/entities";
import type { ITodoUnitOfWork, TodoTransaction } from "../../domain/todo/ports";
import { ReminderScheduleCalculator } from "../../domain/todo/ReminderScheduleCalculator";
import type { TodoCommand, TodoCommandContext, TodoListQuery } from "./contracts";
export declare function todoDetail(tx: TodoTransaction, ownerId: string, id: string): TodoDetail;
export declare class TodoApplicationService {
    readonly uow: ITodoUnitOfWork;
    private readonly clock;
    private readonly calculator;
    constructor(uow: ITodoUnitOfWork, clock?: () => number, calculator?: ReminderScheduleCalculator);
    get(id: string, ownerId: string): TodoDetail;
    list(query: TodoListQuery, ownerId: string): {
        cursor?: string | undefined;
        items: TodoDetail[];
    };
    executions(id: string, ownerId: string, cursor?: string): {
        cursor?: string | undefined;
        items: import("../..").TodoExecution[];
    };
    execute(command: TodoCommand, context: TodoCommandContext): TodoDetail;
    private next;
}
//# sourceMappingURL=TodoApplicationService.d.ts.map