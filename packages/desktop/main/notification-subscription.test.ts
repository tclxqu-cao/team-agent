import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it, expect, vi } from "vitest";
import { DesktopNotificationSubscription } from "./notification-subscription";
import type { SharedServiceConnection, StreamFrame } from "./shared-service";
afterEach(() => vi.useRealTimers());
describe("desktop persistent notification subscription", () => {
  it("rechecks pending state, ACKs actual display separately from read, and persists the service cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "notification-cursor-")), file = join(root, "cursor.json");
    await writeFile(file, JSON.stringify({ "service:owner": 5 }));
    let send: ((frame: StreamFrame) => void) | undefined, end: (() => void) | undefined;
    const notice = { id: "n", ownerId: "owner", sourceEventId: "run:question", kind: "approval", questionId: "q", sessionId: "s", title: "确认", body: "问题", createdAt: 100, cursor: 6, dismissedAt: 101 };
    const ack = vi.fn(), notify = vi.fn(async () => true), errors: unknown[] = [];
    const service = {
      status: async () => ({ connected: true }),
      json: async (path: string, _method: string, body?: string) => {
        if (path.endsWith("/ack")) { ack(JSON.parse(body!)); return { status: 200, body: "{}" }; }
        return { status: 200, body: JSON.stringify(path === "/api/notifications/n" ? notice : { serviceId: "service", ownerId: "owner", items: [notice] }) };
      },
      stream: async (_id: string, _path: string, cursor: string, handler: typeof send) => { expect(cursor).toBe("5"); send = handler; return new Promise<void>(resolve => { end = resolve; }); },
      stop: () => end?.(),
    };
    const subscription = new DesktopNotificationSubscription(service as unknown as SharedServiceConnection, file, notify, error => errors.push(error));
    try {
      subscription.start(); await vi.waitFor(() => expect(send).toBeDefined());
      send!({ id: "persistent-notifications", type: "data", data: `id: 6\ndata: ${JSON.stringify({ serviceId: "service", ownerId: "owner", cursor: 6, items: [{ ...notice, dismissedAt: undefined }], preferences: { completionEnabled: true, soundEnabled: true, notifyWhileForeground: false } })}\n\n` });
      await vi.waitFor(() => expect(ack).toHaveBeenCalledWith({ displayed: false }));
      await vi.waitFor(async () => expect(JSON.parse(await readFile(file, "utf8"))["service:owner"]).toBe(6));
      expect(notify).not.toHaveBeenCalled(); expect(errors).toEqual([]);
    } finally { subscription.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it("persists user-read receipts and retries a failed read without replaying the native notification", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "notification-read-")), file = join(root, "cursor.json");
    let send: ((frame: StreamFrame) => void) | undefined, end: (() => void) | undefined, onRead: (() => Promise<void>) | undefined;
    let failRead = true;
    const n = { id: "n", ownerId: "owner", sourceEventId: "done", kind: "completion", title: "完成", body: "报告", createdAt: 100 };
    const read = vi.fn();
    const service = {
      status: async () => ({ connected: true }),
      readNotification: async (id: string, scope: { serviceId: string; ownerId: string }) => {
        expect(id).toBe("n"); expect(scope).toEqual({ serviceId: "service", ownerId: "owner" });
        read({ read: true });
        if (failRead) throw new Error("offline");
        return { ok: true };
      },
      json: async (path: string, _method: string, body?: string) => {
        if (path.endsWith("/ack")) {
          const value = JSON.parse(body!);
          if (value.read) throw new Error("Read must use the descriptor-bound method");
          return { status: 200, body: "{}" };
        }
        return { status: 200, body: JSON.stringify(path.endsWith("/n") ? n : { serviceId: "service", ownerId: "owner", items: [n] }) };
      },
      stream: async (_id: string, _path: string, _cursor: string, handler: typeof send) => { send = handler; return new Promise<void>(resolve => { end = resolve; }); },
      stop: () => end?.(),
    };
    const notify = vi.fn(async (_n, _prefs, _serviceId, callback) => { onRead = callback; return true; });
    const subscription = new DesktopNotificationSubscription(service as unknown as SharedServiceConnection, file, notify, () => {});
    try {
      subscription.start(); await vi.waitFor(() => expect(send).toBeDefined());
      send!({ id: "persistent-notifications", type: "data", data: `id: 1\ndata: ${JSON.stringify({ serviceId: "service", ownerId: "owner", cursor: 1, items: [n], preferences: {} })}\n\n` });
      await vi.waitFor(() => expect(onRead).toBeDefined());
      await onRead!();
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      expect(JSON.parse(await readFile(`${file}.reads.json`, "utf8"))).toEqual([{ serviceId: "service", ownerId: "owner", notificationId: "n" }]);
      failRead = false;
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(async () => expect(JSON.parse(await readFile(`${file}.reads.json`, "utf8"))).toEqual([]));
      expect(read).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledOnce();
    } finally { subscription.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it("replays saved read receipts only for the selected service and owner after restart", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "notification-read-scope-")), file = join(root, "cursor.json");
    const receipt = { serviceId: "original", ownerId: "owner", notificationId: "n" };
    await writeFile(`${file}.reads.json`, JSON.stringify([receipt]));
    let serviceId = "other", ownerId = "owner";
    const write = vi.fn();
    const service = {
      status: async () => ({ connected: false }),
      readNotification: async (id: string, scope: { serviceId: string; ownerId: string }) => {
        expect(scope).toEqual({ serviceId, ownerId });
        write(`/api/notifications/${id}/ack`); return { ok: true };
      },
      json: async (path: string, method: string) => {
        if (method === "POST") throw new Error("Read must use the descriptor-bound method");
        return { status: 200, body: JSON.stringify({ serviceId, ownerId }) };
      },
      stop() {},
    };
    const subscription = new DesktopNotificationSubscription(service as unknown as SharedServiceConnection, file, vi.fn(), () => {});
    try {
      subscription.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(write).not.toHaveBeenCalled();
      serviceId = "original"; ownerId = "other-owner";
      await vi.advanceTimersByTimeAsync(3000);
      expect(write).not.toHaveBeenCalled();
      ownerId = "owner";
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => expect(write).toHaveBeenCalledWith("/api/notifications/n/ack"));
      await vi.waitFor(async () => expect(JSON.parse(await readFile(`${file}.reads.json`, "utf8"))).toEqual([]));
    } finally { subscription.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it("does not write a read receipt when the selected service changes during the identity recheck", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "notification-read-reconnect-")), file = join(root, "cursor.json");
    const receipt = { serviceId: "original", ownerId: "owner", notificationId: "n" };
    await writeFile(`${file}.reads.json`, JSON.stringify([receipt]));
    let resolveIdentity: ((value: { status: number; body: string }) => void) | undefined;
    const write = vi.fn();
    const service = {
      status: async () => ({ connected: false }),
      readNotification: write,
      json: (path: string, method: string) => method === "POST" ? write(path) : new Promise<{ status: number; body: string }>(resolve => { resolveIdentity = resolve; }),
      stop() {},
    };
    const subscription = new DesktopNotificationSubscription(service as unknown as SharedServiceConnection, file, vi.fn(), () => {});
    try {
      subscription.start();
      await vi.waitFor(() => expect(resolveIdentity).toBeDefined());
      subscription.reconnect();
      resolveIdentity!({ status: 200, body: JSON.stringify({ serviceId: "original", ownerId: "owner" }) });
      await vi.advanceTimersByTimeAsync(100);
      expect(write).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(`${file}.reads.json`, "utf8"))).toEqual([receipt]);
    } finally { subscription.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it("does not redisplay a locally consumed notification while its read acknowledgement is offline", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "notification-read-offline-")), file = join(root, "cursor.json");
    await writeFile(`${file}.reads.json`, JSON.stringify([{ serviceId: "service", ownerId: "owner", notificationId: "n" }]));
    const notice = { id: "n", ownerId: "owner", sourceEventId: "done", kind: "completion", title: "完成", body: "报告", createdAt: 100 };
    let send: ((frame: StreamFrame) => void) | undefined, end: (() => void) | undefined;
    const displayedAck = vi.fn();
    const service = {
      status: async () => ({ connected: true }),
      readNotification: async () => { throw new Error("offline"); },
      json: async (path: string, method: string, body?: string) => {
        if (method === "POST") {
          const ack = JSON.parse(body!);
          if (ack.read) return { status: 500, body: "{}" };
          displayedAck(ack); return { status: 200, body: "{}" };
        }
        return { status: 200, body: JSON.stringify(path.endsWith("/n") ? notice : { serviceId: "service", ownerId: "owner", items: [notice] }) };
      },
      stream: async (_id: string, _path: string, _cursor: string, handler: typeof send) => { send = handler; return new Promise<void>(resolve => { end = resolve; }); },
      stop: () => end?.(),
    };
    const notify = vi.fn(async () => true);
    const subscription = new DesktopNotificationSubscription(service as unknown as SharedServiceConnection, file, notify, () => {});
    try {
      subscription.start(); await vi.waitFor(() => expect(send).toBeDefined());
      send!({ id: "persistent-notifications", type: "data", data: `data: ${JSON.stringify({ serviceId: "service", ownerId: "owner", cursor: 1, items: [notice], preferences: {} })}\n\n` });
      await vi.waitFor(() => expect(displayedAck).toHaveBeenCalledWith({ displayed: false }));
      expect(notify).not.toHaveBeenCalled();
    } finally { subscription.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
