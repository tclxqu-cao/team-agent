import type { TodoTask, TodoReminderSchedule, TodoExecutionSchedule, TodoScheduleLink, TodoReminderOccurrence, TodoExecution, TodoExecutionReport, TodoCommandReceipt, OwnedRecord } from "./entities";
import type { PersistentNotification, NotificationDelivery } from "../notification/entities";
export interface TodoTables {
    todo_tasks: TodoTask;
    todo_reminder_schedules: TodoReminderSchedule;
    todo_schedule_links: TodoScheduleLink;
    todo_reminder_occurrences: TodoReminderOccurrence;
    todo_execution_schedules: TodoExecutionSchedule;
    todo_executions: TodoExecution;
    todo_execution_reports: TodoExecutionReport;
    todo_command_receipts: TodoCommandReceipt;
    notifications: PersistentNotification;
    notification_deliveries: NotificationDelivery;
}
export interface RecordRepository<T extends OwnedRecord> {
    get(ownerId: string, id: string): T | undefined;
    list(ownerId?: string): T[];
    put(record: T, dedupeKey?: string): void;
}
export type TodoTransaction = {
    [K in keyof TodoTables]: RecordRepository<TodoTables[K]>;
};
export interface ITodoUnitOfWork {
    run<T>(work: (transaction: TodoTransaction) => T): T;
}
//# sourceMappingURL=ports.d.ts.map