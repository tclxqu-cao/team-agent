import { createHash } from "node:crypto";
import type { ITodoUnitOfWork, TodoTransaction } from "../../domain/todo/ports";
import { isTodoTerminal, TodoError } from "../../domain/todo/entities";
import type { PersistentNotification } from "../../domain/notification/entities";
export type NotificationIntent = Omit<PersistentNotification, "id" | "cursor" | "readAt">;
export function dismissTaskReminders(tx: TodoTransaction, ownerId: string, taskId: string, at: number): void {
  for (const notification of tx.notifications.list(ownerId)) if (notification.taskId === taskId && notification.kind === "todo_reminder" && !notification.dismissedAt) tx.notifications.put({ ...notification, dismissedAt: at });
}
export function persistNotification(tx: TodoTransaction, intent: NotificationIntent): PersistentNotification {
  const id = createHash("sha256").update(`${intent.ownerId}\0${intent.sourceEventId}`).digest("hex");
  const existing = tx.notifications.get(intent.ownerId, id);
  if (existing) return existing;
  tx.notifications.put({ ...intent, id }, intent.sourceEventId);
  return tx.notifications.get(intent.ownerId, id)!;
}
export class PersistentNotificationService {
  constructor(private readonly uow: ITodoUnitOfWork, private readonly clock = Date.now) {}
  ingest(intent: NotificationIntent) { return this.uow.run(tx => persistNotification(tx, intent)); }
  get(ownerId: string, id: string): PersistentNotification {
    return this.uow.run(tx => { const n = tx.notifications.get(ownerId, id); if (!n) throw new TodoError("NOT_FOUND", "通知不存在"); return n; });
  }
  list(ownerId: string, afterCursor = 0) {
    return this.uow.run(tx => tx.notifications.list(ownerId).filter(n => (n.cursor ?? 0) > afterCursor).sort((a, b) => (a.cursor ?? 0) - (b.cursor ?? 0)).slice(afterCursor ? 0 : -200, afterCursor ? 200 : undefined));
  }
  claim(ownerId: string, deviceId: string, afterCursor = 0) {
    if (!deviceId || deviceId.length > 200) throw new TodoError("INVALID_ARGUMENT", "设备标识无效");
    return this.uow.run(tx => {
      const now = this.clock();
      const all = tx.notifications.list(ownerId).filter(n => (n.cursor ?? 0) > afterCursor).sort((a, b) => (a.cursor ?? 0) - (b.cursor ?? 0));
      const items: PersistentNotification[] = [];
      let cursor = afterCursor;
      for (const n of all.slice(0, 200)) {
        const id = createHash("sha256").update(`${n.id}\0${deviceId}`).digest("hex");
        const delivery = tx.notification_deliveries.get(ownerId, id);
        if (delivery && !delivery.acknowledgedAt && !delivery.displayedAt && delivery.leasedUntil > now) break;
        cursor = n.cursor!;
        const task = n.taskId ? tx.todo_tasks.get(ownerId, n.taskId) : undefined;
        if (n.reminderScheduleId && tx.todo_reminder_schedules.get(ownerId, n.reminderScheduleId)?.generation !== n.reminderGeneration) continue;
        if (n.readAt || n.dismissedAt || (n.kind === "todo_reminder" && (!task || isTodoTerminal(task)))) continue;
        if ((n.kind === "completion" || n.kind === "todo_execution") && now - n.createdAt > 600000) continue;
        if (delivery?.displayedAt || delivery?.acknowledgedAt) continue;
        if ((n.kind === "todo_reminder" || n.kind === "todo_execution") && all.some(other => other.taskId === n.taskId && other.kind === n.kind && other.createdAt > n.createdAt)) continue;
        tx.notification_deliveries.put({ id, ownerId, notificationId: n.id, deviceId, leasedUntil: now + 30000 });
        items.push(n);
      }
      return { items, cursor };
    });
  }
  ack(ownerId: string, id: string, deviceId: string, read = false, displayed = true) {
    return this.uow.run(tx => {
      const notification = tx.notifications.get(ownerId, id);
      if (!notification) throw new TodoError("NOT_FOUND", "通知不存在");
      if (read) tx.notifications.put({ ...notification, readAt: this.clock() });
      else {
        const key = createHash("sha256").update(`${id}\0${deviceId}`).digest("hex");
        tx.notification_deliveries.put({ id: key, ownerId, notificationId: id, deviceId, leasedUntil: 0, acknowledgedAt: this.clock(), ...(displayed ? { displayedAt: this.clock() } : {}) });
      }
      return { ok: true };
    });
  }
  resolveApproval(ownerId: string, sessionId: string, questionId?: string) {
    this.uow.run(tx => { for (const n of tx.notifications.list(ownerId)) if (n.kind === "approval" && n.sessionId === sessionId && (!questionId || n.questionId === questionId)) tx.notifications.put({ ...n, dismissedAt: this.clock() }); });
  }
}
