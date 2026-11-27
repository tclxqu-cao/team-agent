import type { PersistentNotification, TaskNotificationPreferences } from "@agent/core";
import type { SharedServiceConnection } from "./shared-service.js";
/** The main process owns subscription and cursor persistence; closing a chat
 * or suspending the renderer does not stop delivery. OS display is not read. */
export declare class DesktopNotificationSubscription {
    private readonly service;
    private readonly cursorFile;
    private readonly notify;
    private readonly warn;
    private stopped;
    private connecting;
    private epoch;
    private timer?;
    private queue;
    private readQueue;
    private retryingReads;
    constructor(service: SharedServiceConnection, cursorFile: string, notify: (n: PersistentNotification, preferences: TaskNotificationPreferences, serviceId: string, onRead: () => Promise<void>) => Promise<boolean>, warn: (error: unknown) => void);
    start(): void;
    stop(): void;
    private readReceipts;
    private writeReceipts;
    private markRead;
    private retryReads;
    private connect;
    reconnect(): void;
}
//# sourceMappingURL=notification-subscription.d.ts.map