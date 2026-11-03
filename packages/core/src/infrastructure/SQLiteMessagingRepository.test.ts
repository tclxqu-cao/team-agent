import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteMessagingRepository } from "./SQLiteMessagingRepository.js";
import { getDatabase } from "./SQLiteDatabase.js";
import { messageFixture } from "../application/messaging/fixtures.js";

const paths: string[] = [];
afterEach(() => paths.splice(0).forEach(path => { getDatabase(path).close(); rmSync(path, { recursive: true, force: true }); }));
function setup() { const path = mkdtempSync(join(tmpdir(), "messaging-store-")); paths.push(path); return new SQLiteMessagingRepository(path); }
it("atomically saves a collected batch and its cursor, and preserves lossless source IDs", () => {
  const repo = setup();
  repo.ingestBatch([messageFixture({ sourceId: "1152921504606846983" })], "cursor", { generation: "one", lid: "9" });
  repo.ingestBatch([messageFixture({ sourceId: "1152921504606846983" })], "cursor", { generation: "two", lid: "10" });
  const list = repo.list();
  expect(list.counts.total).toBe(1);
  expect(repo.get(list.messages[0].id)?.source.sourceId).toBe("1152921504606846983");
  expect(repo.state("cursor", {})).toEqual({ generation: "two", lid: "10" });
  expect("raw" in list.messages[0].source).toBe(false);
});
it("uses stable timestamp/id pagination and exposes independent worker leases", () => {
  const repo = setup();
  for (let i = 0; i < 61; i++) repo.insert(messageFixture({ sourceId: String(i) }));
  const first = repo.list(); const second = repo.list({ before: first.nextCursor! });
  expect(first.messages).toHaveLength(50); expect(second.messages).toHaveLength(11);
  expect(new Set([...first.messages, ...second.messages].map(item => item.id)).size).toBe(61);
  expect(repo.lease("one")).toBe(true); expect(repo.lease("two")).toBe(false);
  repo.release("one"); expect(repo.lease("two")).toBe(true);
});
it("rejects stale message writes instead of losing evidence", () => {
  const repo = setup(); const a = repo.insert(messageFixture()); const b = repo.get(a.id)!;
  a.execution.error = "new evidence"; repo.save(a);
  b.execution.error = "old evidence"; expect(() => repo.save(b)).toThrow("另一执行器");
  expect(repo.get(a.id)?.execution.error).toBe("new evidence");
});
it("keeps routing context in the same account/conversation and excludes future messages", () => {
  const repo = setup();
  repo.insert(messageFixture({ sourceId: "prior", text: "previous" }));
  const current = repo.insert(messageFixture({ sourceId: "current", text: "current" }));
  repo.insert(messageFixture({ sourceId: "future", text: "future" }));
  repo.insert(messageFixture({ sourceId: "other-account", connectionId: "another", text: "secret" }));
  expect(repo.context(current.source).map(item => item.text)).toEqual(["previous"]);
});
it("does not let old blocked deliveries starve new pending replies or prevent direct retry lookup", () => {
  const repo = setup();
  for (let i = 0; i < 121; i++) repo.addDelivery({
    id: String(i), messageId: "message", eventId: String(i), event: "completed",
    target: { kind: "origin", address: "group", label: "group" }, text: "result",
    status: i === 120 ? "pending" : "blocked", attempts: 0, nextAttemptAt: 0, createdAt: "", updatedAt: "",
  });
  expect(repo.deliveries().map(item => item.id)).toEqual(["120"]);
  expect(repo.delivery("119")?.status).toBe("blocked");
});
