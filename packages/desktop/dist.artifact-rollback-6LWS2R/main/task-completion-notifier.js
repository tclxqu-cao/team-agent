import { NotificationDeduper } from "@agent/core";
export class DesktopTaskCompletionNotifier {
    setVisible(target) { this.visible = target; }
    async notifyPersistent(intent, preferences, serviceId = "", onRead) {
        const enabled = intent.kind === "completion" ? preferences.completionEnabled : intent.kind === "approval" ? preferences.approvalEnabled !== false : preferences.todoEnabled !== false;
        if (!enabled || intent.readAt || intent.dismissedAt)
            return false;
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
            if (!this.deduper.accept(notificationId))
                return false;
            const native = new this.Notification(this.options(intent, preferences));
            let consumed = false;
            const markRead = () => {
                if (consumed)
                    return;
                consumed = true;
                void Promise.resolve().then(() => onRead?.()).catch(error => this.warn("desktop notification read failed", error));
            };
            native.on("click", () => {
                markRead();
                const target = this.getWindow();
                if (!target || target.isDestroyed())
                    return;
                if (target.isMinimized())
                    target.restore();
                target.show();
                target.focus();
                target.webContents.send("notification:open", { sessionId: intent.sessionId, taskId: intent.taskId, questionId: intent.questionId });
            });
            native.on("close", (details) => {
                // Windows also reports expiry and programmatic hiding. macOS emits this
                // event for a user dismissal without a reason; ordinary display is not read.
                if (!details?.reason || details.reason === "userCanceled")
                    markRead();
            });
            return await new Promise(resolve => {
                let settled = false;
                const finish = (shown) => { if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve(shown);
                } };
                const timeout = setTimeout(() => finish(false), 5000);
                native.on("show", () => {
                    if (this.platform === "darwin" || this.platform === "win32")
                        this.playSoundOnce(notificationId, preferences, intent);
                    finish(true);
                });
                native.on("failed", (_event, error) => {
                    this.warn("System did not display the desktop notification", error);
                    this.playSoundOnce(notificationId, preferences, intent);
                    finish(false);
                });
                try {
                    native.show();
                }
                catch (error) {
                    this.warn("desktop notification failed", error);
                    this.playSoundOnce(notificationId, preferences, intent);
                    finish(false);
                }
            });
        }
        catch (error) {
            this.warn("desktop notification failed", error);
            return false;
        }
    }
    constructor(Notification, getWindow, warn, playSound = () => { }, platform = process.platform) {
        this.Notification = Notification;
        this.getWindow = getWindow;
        this.warn = warn;
        this.playSound = playSound;
        this.platform = platform;
        this.visible = {};
        this.deduper = new NotificationDeduper();
        this.soundDeduper = new NotificationDeduper();
    }
    options(notification, preferences) {
        // Supported desktop platforms play the bundled category cue on show.
        return { title: notification.title, body: notification.body,
            silent: this.platform === "darwin" || this.platform === "win32" || !preferences.soundEnabled };
    }
    playSoundOnce(id, preferences, notification) {
        if (!preferences.soundEnabled || !this.soundDeduper.accept(id))
            return;
        try {
            this.playSound(notification);
        }
        catch (error) {
            this.warn("desktop notification sound failed", error);
        }
    }
    notify(notification, preferences) {
        try {
            if (!preferences.completionEnabled || !this.Notification.isSupported())
                return { shown: false };
            const window = this.getWindow();
            if (!preferences.notifyWhileForeground && window?.isFocused()) {
                this.playSoundOnce(notification.notificationId, preferences, { kind: "completion", title: notification.title });
                return { shown: false };
            }
            if (!this.deduper.accept(notification.notificationId))
                return { shown: false };
            const native = new this.Notification(this.options(notification, preferences));
            native.on("show", () => {
                if (this.platform === "darwin" || this.platform === "win32")
                    this.playSoundOnce(notification.notificationId, preferences, { kind: "completion", title: notification.title });
            });
            native.on("click", () => {
                const target = this.getWindow();
                if (!target || target.isDestroyed())
                    return;
                if (target.isMinimized())
                    target.restore();
                target.show();
                target.focus();
                target.webContents.send("task-notification:open-session", { sessionId: notification.sessionId });
            });
            native.show();
            return { shown: true };
        }
        catch (error) {
            this.warn("task completion notification failed", error);
            return { shown: false };
        }
    }
}
//# sourceMappingURL=task-completion-notifier.js.map