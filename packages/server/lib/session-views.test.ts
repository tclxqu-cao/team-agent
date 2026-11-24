import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDatabase, SQLiteDatabase } from "../../core/src/infrastructure/SQLiteDatabase";
import { syncSessionViews } from "./session-views";

vi.mock("@agent/core", async () => ({
  ...await import("../../core/src/infrastructure/SQLiteSessionViews"),
  ...await import("../../core/src/application/session/SyncSessionViews"),
}));

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "agentroam-session-views-")); });
afterEach(() => {
  getDatabase(directory).close();
  rmSync(directory, { recursive: true, force: true });
});

it("shares a view with another device and preserves the newest view across retries", () => {
  const first = { sessionId: "runtime:codex:one", viewedAt: Date.now() - 100 };
  const latest = { ...first, viewedAt: first.viewedAt + 50 };
  const desktop = syncSessionViews(0, [first], directory);
  expect(syncSessionViews(0, [], directory)).toEqual(desktop);
  const phone = syncSessionViews(desktop.revision, [latest], directory);
  expect(phone.views).toEqual([latest]);
  expect(syncSessionViews(desktop.revision, [first, latest], directory)).toEqual(phone);
  expect(syncSessionViews(phone.revision, [], directory)).toEqual({ views: [], revision: phone.revision, hasMore: false });
});

it("paginates the initial snapshot and reads the receipts from another database connection", () => {
  const viewedAt = Date.now() - 100;
  const entries = Array.from({ length: 260 }, (_, index) => ({ sessionId: `session-${index}`, viewedAt }));
  syncSessionViews(0, entries.slice(0, 256), directory);
  syncSessionViews(0, entries.slice(256), directory);
  const first = syncSessionViews(0, [], directory);
  const second = syncSessionViews(first.revision, [], directory);
  expect(first).toMatchObject({ revision: 256, hasMore: true, views: entries.slice(0, 256) });
  expect(second).toMatchObject({ revision: 260, hasMore: false, views: entries.slice(256) });
  const reopened = new SQLiteDatabase(directory);
  try {
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM session_views").get()).toEqual({ count: 260 });
  } finally {
    reopened.close();
  }
});

it("caps a future timestamp so later completions can become unread", () => {
  const now = Date.now();
  const page = syncSessionViews(0, [{ sessionId: "clock-skew", viewedAt: now + 60_000 }], directory);
  expect(page.views[0].viewedAt).toBeGreaterThanOrEqual(now);
  expect(page.views[0].viewedAt).toBeLessThan(now + 60_000);
});
