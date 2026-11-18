import { NotificationDeduper, type TaskCompletionNotification, type TaskNotificationPreferences, type PersistentNotification } from "@agent/core";
import type { NotificationSoundIntent } from "../shared/notification-presentation.js";

interface NativeNotification {
  show(): void;
  on(event: "click" | "show", listener: () => void): void;
  on(event: "failed", listener: (event: unknown, error: string) => void): void;
  on(event: "close", listener: (details?: { reason?: "userCanceled" | "applicationHidden" | "timedOut" }) => void): void;
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
  private visible: { sessionId?: string; taskId?: string } = {};
  setVisible(target: { sessionId?: string; taskId?: string }): void { this.visible = target; }
  async notifyPersistent(intent: PersistentNotification, preferences: TaskNotificationPreferences, serviceId = "", onRead?: () => void | Promise<void>): Promise<boolean> {
    const enabled = intent.kind === "completion" ? preferences.completionEnabled : intent.kind === "approval" ? preferences.approvalEnabled !== false : preferences.todoEnabled !== false;
    if (!enabled || intent.readAt || intent.dismissedAt) return false;
    const window = this.getWindow();
    const notificationId = `${serviceId}:${intent.ownerId}:${intent.id}`;
    if (!preferences.notifyWhileForeground && window?.isFocused()) {
      this.playSoundOnce(notificationId, preferences, intent);
      return false;
    }
    try {
      if (!this.Notification.isSupported()) {
        this.playSoundOnce(notificationId, preferences, intent);
        return false;
      }
      if (!this.deduper.accept(notificationId)) return false;
      const native = new this.Notification(this.options(intent, preferences));
      let consumed = false;
      const markRead = () => {
        if (consumed) return;
        consumed = true;
        void Promise.resolve().then(() => onRead?.()).catch(error => this.warn("desktop notification read failed", error));
      };
      native.on("click", () => {
        markRead();
        const target = this.getWindow(); if (!target || target.isDestroyed()) return;
        if (target.isMinimized()) target.restore(); target.show(); target.focus();
        target.webContents.send("notification:open", { sessionId: intent.sessionId, taskId: intent.taskId, questionId: intent.questionId });
      });
      native.on("close", (details) => {
        // Windows also reports expiry and programmatic hiding. macOS emits this
        // event for a user dismissal without a reason; ordinary display is not read.
        if (!details?.reason || details.reason === "userCanceled") markRead();
      });
      return await new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (shown: boolean) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(shown); } };
        const timeout = setTimeout(() => finish(false), 5000);
        native.on("show", () => {
          if (this.platform === "darwin" || this.platform === "win32") this.playSoundOnce(notificationId, preferences, intent);
          finish(true);
        });
        native.on("failed", (_event, error) => {
          this.warn("System did not display the desktop notification", error);
          this.playSoundOnce(notificationId, preferences, intent);
          finish(false);
        });
        try { native.show(); } catch (error) {
          this.warn("desktop notification failed", error);
          this.playSoundOnce(notificationId, preferences, intent);
          finish(false);
        }
      });
    } catch (error) { this.warn("desktop notification failed", error); return false; }
  }
  private readonly deduper = new NotificationDeduper();
  private readonly soundDeduper = new NotificationDeduper();

  constructor(
    private readonly Notification: NativeNotificationConstructor,
    private readonly getWindow: () => NotifierWindow | null,
    private readonly warn: (message: string, error?: unknown) => void,
    private readonly playSound: (notification: NotificationSoundIntent) => void = () => {},
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private options(notification: { title: string; body: string }, preferences: TaskNotificationPreferences) {
    // Supported desktop platforms play the bundled category cue on show.
    return { title: notification.title, body: notification.body,
      silent: this.platform === "darwin" || this.platform === "win32" || !preferences.soundEnabled };
  }

  private playSoundOnce(id: string, preferences: TaskNotificationPreferences, notification: NotificationSoundIntent): void {
    if (!preferences.soundEnabled || !this.soundDeduper.accept(id)) return;
    try { this.playSound(notification); } catch (error) { this.warn("desktop notification sound failed", error); }
  }

  notify(notification: TaskCompletionNotification, preferences: TaskNotificationPreferences): { shown: boolean } {
    try {
      if (!preferences.completionEnabled || !this.Notification.isSupported()) return { shown: false };
      const window = this.getWindow();
      if (!preferences.notifyWhileForeground && window?.isFocused()) {
        this.playSoundOnce(notification.notificationId, preferences, { kind: "completion", title: notification.title });
        return { shown: false };
      }
      if (!this.deduper.accept(notification.notificationId)) return { shown: false };
      const native = new this.Notification(this.options(notification, preferences));
      native.on("show", () => {
        if (this.platform === "darwin" || this.platform === "win32") this.playSoundOnce(notification.notificationId, preferences, { kind: "completion", title: notification.title });
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
