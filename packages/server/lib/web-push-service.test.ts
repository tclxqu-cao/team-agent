import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { WebPushService } from "./web-push-service.mjs";

const temporaryDirectories: string[] = [];
const clocks: Array<() => number> = [];
const now = () => clocks.at(-1)?.() ?? 1_000_000;

const VALID_SUBSCRIPTION = {
  endpoint: "https://push.example.com/send/abc123",
  keys: { p256dh: "BKeyOfBase64Value123", auth: "AuthOfBase64Value456" },
};

async function createService(): Promise<WebPushService> {
  const dataDir = await mkdtemp(join(tmpdir(), "web-push-"));
  temporaryDirectories.push(dataDir);
  return new WebPushService(dataDir, now);
}

beforeEach(() => {
  clocks.push(() => 1_000_000);
});

afterEach(async () => {
  clocks.splice(0).length = 0;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WebPushService", () => {
  it("generates VAPID keys once and persists them across restarts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "web-push-"));
    temporaryDirectories.push(dataDir);
    const first = new WebPushService(dataDir, now);
    const second = new WebPushService(dataDir, now);
    expect(first.getPublicKey()).toBeTruthy();
    expect(second.getPublicKey()).toBe(first.getPublicKey());
  });

  it("stores, refreshes, and removes device subscriptions", async () => {
    const service = await createService();

    expect(() => service.saveSubscription("device-1", {
      endpoint: "http://insecure.example.com",
      keys: VALID_SUBSCRIPTION.keys,
    })).toThrow();
    expect(() => service.saveSubscription("device-1", {
      endpoint: VALID_SUBSCRIPTION.endpoint,
      keys: { p256dh: "", auth: "x" },
    })).toThrow();

    service.saveSubscription("device-1", VALID_SUBSCRIPTION);
    service.saveSubscription("device-1", {
      endpoint: VALID_SUBSCRIPTION.endpoint,
      keys: { p256dh: "refreshed", auth: "refreshed-auth" },
    });
    expect(service.listSubscriptions()).toHaveLength(1);
    expect(service.listSubscriptions()[0]).toMatchObject({
      endpoint: VALID_SUBSCRIPTION.endpoint,
      deviceId: "device-1",
      keys: { p256dh: "refreshed", auth: "refreshed-auth" },
    });

    service.deleteSubscription(VALID_SUBSCRIPTION.endpoint);
    expect(service.listSubscriptions()).toHaveLength(0);
  });

  it("deduplicates notifications per session+kind inside the window", async () => {
    const service = await createService();
    const sent: Array<Record<string, unknown>> = [];
    service.sendToAll = async (payload: Record<string, unknown>) => {
      sent.push(payload);
    };

    service.notifySession({ sessionId: "s1", kind: "approval", title: "t", body: "b", url: "/app/" });
    service.notifySession({ sessionId: "s1", kind: "approval", title: "t", body: "b", url: "/app/" });
    expect(sent).toHaveLength(1);

    clocks.push(() => 1_000_000 + 5_000);
    service.notifySession({ sessionId: "s1", kind: "approval", title: "t", body: "b", url: "/app/" });
    service.notifySession({ sessionId: "s1", kind: "done", title: "t", body: "b", url: "/app/" });
    expect(sent).toHaveLength(3);
  });

  it("drops subscriptions the push endpoint reports as gone", async () => {
    const service = await createService();
    service.saveSubscription("device-1", VALID_SUBSCRIPTION);
    const original = webpush.sendNotification;
    const gone = new Error("gone") as { statusCode?: number };
    gone.statusCode = 410;
    webpush.sendNotification = () => {
      throw gone;
    };
    try {
      await service.send(service.listSubscriptions()[0], { title: "t" });
    } finally {
      webpush.sendNotification = original;
    }
    expect(service.listSubscriptions()).toHaveLength(0);
  });
});
