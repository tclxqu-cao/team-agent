import { NotificationDeduper, type TaskCompletionNotification, type TaskNotificationPreferences } from "@agent/core";

interface NativeNotification {
  show(): void;
  on(event: "click", listener: () => void): void;
}

interface NativeNotificationConstructor {
  new(options: { title: string; body: string; silent: boolean }): NativeNotification;
  isSupported(): boolean;
}

interface NotifierWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: { send(channel: string, payload: unknown): void };
}

export class DesktopTaskCompletionNotifier {
  private readonly deduper = new NotificationDeduper();

  constructor(
    private readonly Notification: NativeNotificationConstructor,
    private readonly getWindow: () => NotifierWindow | null,
    private readonly warn: (message: string, error?: unknown) => void,
  ) {}

  notify(notification: TaskCompletionNotification, preferences: TaskNotificationPreferences): { shown: boolean } {
    try {
      if (!preferences.completionEnabled || !this.Notification.isSupported()) return { shown: false };
      const window = this.getWindow();
      if (!preferences.notifyWhileForeground && window?.isFocused()) return { shown: false };
      if (!this.deduper.accept(notification.notificationId)) return { shown: false };
      const native = new this.Notification({
        title: notification.title,
        body: notification.body,
        silent: !preferences.soundEnabled,
      });
      native.on("click", () => {
        const target = this.getWindow();
        if (!target || target.isDestroyed()) return;
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
        target.webContents.send("task-notification:open-session", { sessionId: notification.sessionId });
      });
      native.show();
      return { shown: true };
    } catch (error) {
      this.warn("task completion notification failed", error);
      return { shown: false };
    }
  }
}
