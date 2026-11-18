import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteDatabase } from "@agent/core";
import { RuntimeNotificationOutbox } from "./runtime-notification-outbox";
describe("Broker notification outbox", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
  it("rolls back with the event transaction, deduplicates and survives broker replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "todo-outbox-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const db = new SQLiteDatabase(root); cleanup.push(() => db.close());
    let outbox = new RuntimeNotificationOutbox(db.db); cleanup.push(() => outbox.close());
    outbox.set("session", { serviceId: "service", ownerId: "owner", descriptorPath: "/scoped", relayPath: "/relay" });
    expect(() => db.db.transaction(() => { outbox.append("session", "run", 1, { type: "done", finalText: "complete" }, 100); throw new Error("rollback"); })()).toThrow("rollback");
    expect(db.db.prepare("SELECT * FROM native_runtime_notification_outbox").all()).toHaveLength(0);
    outbox.append("session", "run", 1, { type: "done", finalText: "complete" }, 100); outbox.append("session", "run", 1, { type: "done", finalText: "complete" }, 100);
    expect(db.db.prepare("SELECT * FROM native_runtime_notification_outbox").all()).toHaveLength(1);
    outbox.close(); outbox = new RuntimeNotificationOutbox(db.db);
    expect(outbox.get("session")?.serviceId).toBe("service");
    expect(() => outbox.set("session", { serviceId: "other", ownerId: "owner", descriptorPath: "/different" })).toThrow("another Todo scope");
  });
});
