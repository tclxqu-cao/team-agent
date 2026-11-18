import { describe, it, expect, vi } from "vitest";
import { DesktopTaskCompletionNotifier } from "./task-completion-notifier";

const preferences = { completionEnabled: true, soundEnabled: true, notifyWhileForeground: false };
const notice = { id: "n", ownerId: "owner", sourceEventId: "event", kind: "completion" as const, title: "完成", body: "报告", createdAt: 1, sessionId: "background" };
type NotificationDetails = { reason?: "userCanceled" | "applicationHidden" | "timedOut" };
type NotificationListener = ((details?: NotificationDetails) => void) | ((event: unknown, error: string) => void);

function fixture({ focused = false, destroyed = false, supported = true, showFailure = false, platform = "darwin" as NodeJS.Platform } = {}) {
  const instances: Notification[] = [];
  class Notification {
    handlers = new Map<string, (details?: NotificationDetails, error?: string) => void>();
    constructor(readonly options: unknown) { instances.push(this); }
    static isSupported() { return supported; }
    on(event: string, listener: NotificationListener) {
      this.handlers.set(event, (details, error) => {
        if (event === "failed") (listener as (event: unknown, error: string) => void)(details, error ?? "");
        else (listener as (details?: NotificationDetails) => void)(details);
      });
    }
    show() { this.handlers.get(showFailure ? "failed" : "show")?.(undefined, "Notification permission denied"); }
    emit(event: string, details?: { reason?: "userCanceled" | "applicationHidden" | "timedOut" }) { this.handlers.get(event)?.(details); }
  }
  const window = { isDestroyed: () => destroyed, isFocused: () => focused, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } };
  const warn = vi.fn(), playSound = vi.fn();
  return { notifier: new DesktopTaskCompletionNotifier(Notification, () => window, warn, playSound, platform), instances, window, warn, playSound };
}

describe("persistent desktop notification policy", () => {
  it("uses global app toasts in the foreground unless system notifications were explicitly enabled", async () => {
    const { notifier, instances } = fixture({ focused: true });
    notifier.setVisible({ sessionId: "active" });
    expect(await notifier.notifyPersistent(notice, preferences)).toBe(false);
    expect(await notifier.notifyPersistent({ ...notice, sessionId: "active" }, preferences)).toBe(false);
    expect(instances).toHaveLength(0);
    expect(await notifier.notifyPersistent(notice, { ...preferences, notifyWhileForeground: true })).toBe(true);
  });

  it("does not mark display as read and deduplicates click followed by close", async () => {
    const { notifier, instances, window } = fixture();
    const read = vi.fn();
    expect(await notifier.notifyPersistent(notice, preferences, "service", read)).toBe(true);
    expect(instances[0].options).toEqual({ title: "完成", body: "报告", silent: true });
    expect(read).not.toHaveBeenCalled();
    instances[0].emit("click"); instances[0].emit("close");
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith("notification:open", { sessionId: "background", taskId: undefined, questionId: undefined });
    expect(await notifier.notifyPersistent(notice, preferences, "service", read)).toBe(false);
  });

  it.each([undefined, "userCanceled"] as const)("marks a user dismissal as read even without a usable window (%s)", async reason => {
    const { notifier, instances } = fixture({ destroyed: true });
    const read = vi.fn();
    await notifier.notifyPersistent(notice, preferences, "service", read);
    instances[0].emit("close", reason ? { reason } : undefined);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  });

  it.each(["timedOut", "applicationHidden"] as const)("keeps a Windows %s notification unread", async reason => {
    const { notifier, instances } = fixture();
    const read = vi.fn();
    await notifier.notifyPersistent(notice, preferences, "service", read);
    instances[0].emit("close", { reason });
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not consume already read, disabled, unsupported, or failed notifications", async () => {
    const { notifier, instances } = fixture();
    expect(await notifier.notifyPersistent({ ...notice, readAt: 2 }, preferences)).toBe(false);
    expect(await notifier.notifyPersistent(notice, { ...preferences, completionEnabled: false })).toBe(false);
    expect(instances).toHaveLength(0);
    expect(await fixture({ supported: false }).notifier.notifyPersistent(notice, preferences)).toBe(false);
    const failed = fixture({ showFailure: true }), read = vi.fn();
    expect(await failed.notifier.notifyPersistent(notice, preferences, "service", read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(failed.warn).toHaveBeenCalled();
  });

  it("plays one foreground cue per service/owner/notification without marking it read", async () => {
    const { notifier, playSound, instances } = fixture({ focused: true });
    const read = vi.fn();
    await notifier.notifyPersistent({ ...notice, kind: "approval" }, preferences, "service", read);
    await notifier.notifyPersistent({ ...notice, kind: "approval" }, preferences, "service", read);
    expect(playSound).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    await notifier.notifyPersistent({ ...notice, kind: "approval" }, preferences, "other-service", read);
    expect(playSound).toHaveBeenCalledTimes(2);
  });

  it("honors sound off and consumes no sound for disabled or read notifications", async () => {
    const { notifier, playSound } = fixture({ focused: true });
    await notifier.notifyPersistent(notice, { ...preferences, soundEnabled: false });
    await notifier.notifyPersistent(notice, { ...preferences, completionEnabled: false });
    await notifier.notifyPersistent({ ...notice, readAt: 2 }, preferences);
    await notifier.notifyPersistent({ ...notice, dismissedAt: 2 }, preferences);
    expect(playSound).not.toHaveBeenCalled();
  });

  it("plays one app cue with a silent macOS banner without repeating it on replay", async () => {
    const { notifier, playSound, instances } = fixture({ focused: true });
    await notifier.notifyPersistent(notice, { ...preferences, notifyWhileForeground: true });
    expect(instances[0].options).toMatchObject({ silent: true });
    expect(playSound).toHaveBeenCalledOnce();
    await notifier.notifyPersistent(notice, { ...preferences, notifyWhileForeground: true });
    expect(playSound).toHaveBeenCalledOnce();
  });

  it("keeps native Windows and macOS banners silent while using the app cue", async () => {
    const windows = fixture({ platform: "win32" });
    await windows.notifier.notifyPersistent(notice, preferences);
    expect(windows.instances[0].options).toEqual({ title: "完成", body: "报告", silent: true });
    expect(windows.playSound).toHaveBeenCalledWith(notice);
    const mac = fixture();
    await mac.notifier.notifyPersistent(notice, { ...preferences, soundEnabled: false });
    expect(mac.instances[0].options).toEqual({ title: "完成", body: "报告", silent: true });
    expect(mac.playSound).not.toHaveBeenCalled();
  });

  it("logs the native failure reason and plays a fallback cue only once", async () => {
    const { notifier, warn, playSound } = fixture({ showFailure: true });
    await notifier.notifyPersistent(notice, preferences);
    await notifier.notifyPersistent(notice, preferences);
    expect(warn).toHaveBeenCalledWith("System did not display the desktop notification", "Notification permission denied");
    expect(playSound).toHaveBeenCalledOnce();
  });
});
