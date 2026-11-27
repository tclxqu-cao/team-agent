import { type TaskCompletionNotification, type TaskNotificationPreferences, type PersistentNotification } from "@agent/core";
import type { NotificationSoundIntent } from "../shared/notification-presentation.js";
interface NativeNotification {
    show(): void;
    on(event: "click" | "show", listener: () => void): void;
    on(event: "failed", listener: (event: unknown, error: string) => void): void;
    on(event: "close", listener: (details?: {
        reason?: "userCanceled" | "applicationHidden" | "timedOut";
    }) => void): void;
}
interface NativeNotificationConstructor {
    new (options: {
        title: string;
        body: string;
        silent: boolean;
    }): NativeNotification;
    isSupported(): boolean;
}
interface NotifierWindow {
    isDestroyed(): boolean;
    isFocused(): boolean;
    isMinimized(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
    webContents: {
        send(channel: string, payload: unknown): void;
    };
}
export declare class DesktopTaskCompletionNotifier {
    private readonly Notification;
    private readonly getWindow;
    private readonly warn;
    private readonly playSound;
    private readonly platform;
    private visible;
    setVisible(target: {
        sessionId?: string;
        taskId?: string;
    }): void;
    notifyPersistent(intent: PersistentNotification, preferences: TaskNotificationPreferences, serviceId?: string, onRead?: () => void | Promise<void>): Promise<boolean>;
    private readonly deduper;
    private readonly soundDeduper;
    constructor(Notification: NativeNotificationConstructor, getWindow: () => NotifierWindow | null, warn: (message: string, error?: unknown) => void, playSound?: (notification: NotificationSoundIntent) => void, platform?: NodeJS.Platform);
    private options;
    private playSoundOnce;
    notify(notification: TaskCompletionNotification, preferences: TaskNotificationPreferences): {
        shown: boolean;
    };
}
export {};
//# sourceMappingURL=task-completion-notifier.d.ts.map