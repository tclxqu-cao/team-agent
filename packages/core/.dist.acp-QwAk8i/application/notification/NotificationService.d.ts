import type { ITodoUnitOfWork, TodoTransaction } from "../../domain/todo/ports";
import type { PersistentNotification } from "../../domain/notification/entities";
export type NotificationIntent = Omit<PersistentNotification, "id" | "cursor" | "readAt">;
export declare function dismissTaskReminders(tx: TodoTransaction, ownerId: string, taskId: string, at: number): void;
export declare function persistNotification(tx: TodoTransaction, intent: NotificationIntent): PersistentNotification;
export declare class PersistentNotificationService {
    private readonly uow;
    private readonly clock;
    constructor(uow: ITodoUnitOfWork, clock?: () => number);
    ingest(intent: NotificationIntent): PersistentNotification;
    get(ownerId: string, id: string): PersistentNotification;
    list(ownerId: string, afterCursor?: number): PersistentNotification[];
    claim(ownerId: string, deviceId: string, afterCursor?: number): {
        items: PersistentNotification[];
        cursor: number;
    };
    ack(ownerId: string, id: string, deviceId: string, read?: boolean, displayed?: boolean): {
        ok: boolean;
    };
    resolveApproval(ownerId: string, sessionId: string, questionId?: string): void;
}
//# sourceMappingURL=NotificationService.d.ts.map