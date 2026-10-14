import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultComputerSettings, validateComputerTools } from "../domain/web-console/computer-settings";
import { SQLiteDatabase, getDatabase } from "./SQLiteDatabase";
import { SQLiteAuthStore } from "./SQLiteAuthStore";
import { SQLiteWebConsoleStore } from "./SQLiteWebConsoleStore";

const directories: string[] = [];
const now = "2026-10-13T00:00:00.000Z";
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "computer-settings-")); directories.push(base);
  new SQLiteAuthStore(base).createFirstUser({ id: "owner", usernameNormalized: "local", usernameDisplay: "local", passwordHash: Buffer.alloc(32), passwordSalt: Buffer.alloc(16), passwordVersion: 1, createdAt: now, passwordChangedAt: now });
  return { base, store: new SQLiteWebConsoleStore(base) };
}
afterEach(() => { for (const base of directories.splice(0)) { try { getDatabase(base).close(); } catch {} rmSync(base, { recursive: true, force: true }); } });

describe("SQLite computer settings", () => {
  it("retains an explicitly enabled group tool after reopening the database", () => {
    const { base, store } = fixture();
    const value = { ...defaultComputerSettings("owner"), revision: 1, visibleTools: validateComputerTools(["collaboration", "refresh"]), savedPages: [], updatedAt: now };
    expect(store.saveComputerSettings(value, null)).toBe(true);
    getDatabase(base).close();
    const reopened = new SQLiteDatabase(base);
    const row = reopened.db.prepare("SELECT visible_tools_json FROM computer_settings WHERE user_id=?").get("owner") as { visible_tools_json: string };
    expect(validateComputerTools(JSON.parse(row.visible_tools_json))).toEqual(["refresh", "collaboration"]);
    reopened.close();
  });

  it("persists empty tools and pages through a closed connection and database reopen", () => {
    const { base, store } = fixture();
    const value = { ...defaultComputerSettings("owner"), revision: 1, visibleTools: [], savedPages: [], updatedAt: now };
    expect(store.saveComputerSettings(value, null)).toBe(true);
    expect(store.getComputerSettings("owner")).toEqual(value);
    getDatabase(base).close();
    const reopened = new SQLiteDatabase(base);
    expect(reopened.db.prepare("SELECT visible_tools_json, saved_pages_json, revision FROM computer_settings WHERE user_id=?").get("owner")).toEqual({ visible_tools_json: "[]", saved_pages_json: "[]", revision: 1 });
    reopened.close();
  });
  it("keeps computers isolated and rejects stale or duplicate writes", () => {
    const a = fixture(), b = fixture();
    const value = { ...defaultComputerSettings("owner"), revision: 1, savedPages: [{ id: "docs", name: "文档", url: "https://example.com/", openMode: "current" as const }], updatedAt: now };
    expect(a.store.saveComputerSettings(value, null)).toBe(true);
    expect(b.store.getComputerSettings("owner")).toBeNull();
    expect(a.store.saveComputerSettings({ ...value, visibleTools: [] }, null)).toBe(false);
    expect(a.store.saveComputerSettings({ ...value, revision: 2, savedPages: [] }, 1)).toBe(true);
    expect(a.store.saveComputerSettings({ ...value, revision: 2 }, 1)).toBe(false);
    expect(a.store.getComputerSettings("owner")?.savedPages).toEqual([]);
    expect(a.store.getComputerSettings("different-owner")).toBeNull();
  });
  it("creates the settings table for an existing database without changing other preferences", () => {
    const { base, store } = fixture();
    const preferences = { userId: "owner", revision: 1, theme: "black", terminalFontSize: 13, fileButtonPosition: { xRatio: .9, yRatio: .7, anchor: "right" as const }, keybarPosition: { xRatio: .5, yRatio: .9, anchor: "bottom" as const }, keybarHidden: true, keyOrder: ["Ctrl"], pinnedCommands: [], updatedAt: now };
    store.savePreferences(preferences, null);
    getDatabase(base).db.exec("DROP TABLE computer_settings");
    const migrated = new SQLiteDatabase(base);
    expect(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='computer_settings'").get()).toBeTruthy();
    migrated.close();
    expect(store.saveComputerSettings({ ...defaultComputerSettings("owner"), revision: 1, updatedAt: now }, null)).toBe(true);
    expect(store.getPreferences("owner")).toEqual(preferences);
    expect(store.getComputerSettings("owner")?.savedPages).toBeNull();
  });
});
