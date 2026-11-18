import { describe, expect, it, vi } from "vitest";
import type { PersistentNotification } from "@agent/core";
import { NotificationToastInbox, type NotificationSnapshot } from "./notification-toast-inbox";

const notification = (id: string, extra: Partial<PersistentNotification> = {}): PersistentNotification => ({
  id, ownerId: "owner", sourceEventId: id, title: "会话已完成", body: "任务已完成", kind: "completion", createdAt: 100, ...extra,
});

function fixture() {
  let snapshot: NotificationSnapshot = { serviceId: "service", ownerId: "owner", items: [notification("one")] };
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const read = vi.fn(async (id: string, scope: { serviceId: string; ownerId: string }) => {
    if (snapshot.serviceId !== scope.serviceId || snapshot.ownerId !== scope.ownerId) throw new Error("Notification scope changed");
    snapshot = { ...snapshot, items: snapshot.items.map(item => item.id === id ? { ...item, readAt: 200 } : item) };
  });
  const api = { list: vi.fn(async () => snapshot), read };
  const warnings = vi.fn();
  const inbox = new NotificationToastInbox(api, storage, warnings);
  let visible: PersistentNotification[] = [];
  inbox.subscribe(items => { visible = items; });
  return { inbox, api, storage, warnings, set: (value: NotificationSnapshot) => { snapshot = value; }, get: () => snapshot, visible: () => visible };
}

describe("global persistent notification toasts", () => {
  it("only displays enabled unread notifications for the selected owner", async () => {
    const f = fixture();
    f.set({ serviceId: "service", ownerId: "owner", items: [
      notification("read", { readAt: 1 }), notification("dismissed", { dismissedAt: 1 }),
      notification("foreign", { ownerId: "another" }), notification("one"),
      notification("latest", { createdAt: 300 }), notification("approval", { kind: "approval" }),
    ], preferences: { completionEnabled: true, approvalEnabled: false, todoEnabled: true, soundEnabled: true, notifyWhileForeground: false } });
    await f.inbox.refresh();
    expect(f.visible().map(item => item.id)).toEqual(["latest", "one"]);
  });

  it.each(["open", "close"])("consumes %s persistently and does not replay after polling or restart", async () => {
    const f = fixture();
    await f.inbox.refresh();
    const item = f.visible()[0];
    const reading = f.inbox.consume(item);
    expect(f.visible()).toEqual([]);
    await reading;
    await f.inbox.refresh();
    expect(f.api.read).toHaveBeenCalledTimes(1);
    expect(f.api.read).toHaveBeenCalledWith("one", { serviceId: "service", ownerId: "owner" });
    expect(f.get().items[0].readAt).toBe(200);
    let restored: PersistentNotification[] = [];
    const reload = new NotificationToastInbox(f.api, f.storage);
    reload.subscribe(items => { restored = items; });
    await reload.refresh();
    expect(restored).toEqual([]);
  });

  it("keeps an offline dismissal hidden across reload and retries the durable read", async () => {
    const f = fixture();
    await f.inbox.refresh();
    f.api.read.mockRejectedValueOnce(new Error("offline"));
    await f.inbox.consume(f.visible()[0]);
    expect(f.visible()).toEqual([]);
    expect(f.get().items[0].readAt).toBeUndefined();
    let visible: PersistentNotification[] = [];
    const reload = new NotificationToastInbox(f.api, f.storage);
    reload.subscribe(items => { visible = items; });
    await reload.refresh();
    expect(visible).toEqual([]);
    expect(f.get().items[0].readAt).toBe(200);
    expect(f.api.read).toHaveBeenCalledTimes(2);
  });

  it("clears every pending toast including items beyond the three visible cards", async () => {
    const f = fixture();
    f.set({ ...f.get(), items: Array.from({ length: 6 }, (_, index) => notification(`notice-${index}`)) });
    await f.inbox.refresh();
    expect(f.visible()).toHaveLength(6);
    const clearing = f.inbox.consumeAll();
    expect(f.visible()).toEqual([]);
    await clearing;
    expect(f.api.read).toHaveBeenCalledTimes(6);
    expect(f.get().items.every(item => item.readAt === 200)).toBe(true);
    await f.inbox.refresh();
    expect(f.visible()).toEqual([]);
  });

  it("persists a clear-all while offline and resumes all acknowledgements after reload", async () => {
    const f = fixture();
    f.set({ ...f.get(), items: [notification("one"), notification("two"), notification("three")] });
    await f.inbox.refresh();
    f.api.read.mockRejectedValueOnce(new Error("offline"));
    await f.inbox.consumeAll();
    expect(f.visible()).toEqual([]);
    expect(f.get().items.every(item => !item.readAt)).toBe(true);
    const reload = new NotificationToastInbox(f.api, f.storage);
    let restored: PersistentNotification[] = [];
    reload.subscribe(items => { restored = items; });
    await reload.refresh();
    expect(restored).toEqual([]);
    expect(f.get().items.every(item => item.readAt === 200)).toBe(true);
  });

  it("does not send another service's queued read after a connection switch", async () => {
    const f = fixture();
    await f.inbox.refresh();
    const item = f.visible()[0];
    const original = f.get();
    f.set({ ...original, serviceId: "other-service" });
    await f.inbox.consume(item);
    expect(f.api.read).not.toHaveBeenCalled();
    await f.inbox.refresh();
    expect(f.visible().map(item => item.id)).toEqual(["one"]);
    f.set(original);
    await f.inbox.refresh();
    expect(f.visible()).toEqual([]);
    expect(f.api.read).toHaveBeenCalledTimes(1);
    expect(f.api.read).toHaveBeenCalledWith("one", { serviceId: "service", ownerId: "owner" });
  });

  it("hides notifications read or resolved on another client", async () => {
    const f = fixture();
    f.set({ ...f.get(), items: [notification("one"), notification("two", { kind: "approval" })] });
    await f.inbox.refresh();
    expect(f.visible()).toHaveLength(2);
    f.set({ ...f.get(), items: [notification("one", { readAt: 200 }), notification("two", { dismissedAt: 200 })] });
    await f.inbox.refresh();
    expect(f.visible()).toEqual([]);
    expect(f.api.read).not.toHaveBeenCalled();
  });

  it("retains the original scope when selection changes between recheck and write", async () => {
    const f = fixture();
    await f.inbox.refresh();
    const original = f.get();
    const item = f.visible()[0];
    f.api.list.mockImplementationOnce(async () => {
      f.set({ ...original, serviceId: "other-service" });
      return original;
    });
    await f.inbox.consume(item);
    expect(f.api.read).toHaveBeenCalledWith("one", { serviceId: "service", ownerId: "owner" });
    expect(f.get().items[0].readAt).toBeUndefined();
    f.set(original);
    await f.inbox.refresh();
    expect(f.get().items[0].readAt).toBe(200);
  });

  it("does not resurrect a consumed toast from a stale snapshot or duplicate click", async () => {
    const f = fixture();
    await f.inbox.refresh();
    const stale = f.get();
    const item = f.visible()[0];
    await Promise.all([f.inbox.consume(item), f.inbox.consume(item)]);
    f.set(stale);
    await f.inbox.refresh();
    expect(f.visible()).toEqual([]);
    expect(f.api.read).toHaveBeenCalledTimes(1);
  });
});
