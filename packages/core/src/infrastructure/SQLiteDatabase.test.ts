import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteDatabase } from "./SQLiteDatabase.js";

const directories: string[] = [];
const databases: SQLiteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openDatabase(directory?: string): SQLiteDatabase {
  if (!directory) {
    directory = mkdtempSync(join(tmpdir(), "agentroam-sqlite-native-"));
    directories.push(directory);
  }
  const database = new SQLiteDatabase(directory);
  databases.push(database);
  return database;
}

describe("SQLite Node-API initialization", () => {
  it("preserves WAL, foreign keys, transactions and persisted rows", () => {
    const database = openDatabase();
    expect(database.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.db.pragma("foreign_keys", { simple: true })).toBe(1);
    database.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("runtime-probe", "persisted");
    const rollback = database.db.transaction(() => {
      database.db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("rollback", "runtime-probe");
      throw new Error("abort transaction");
    });
    expect(rollback).toThrow("abort transaction");
    database.close();
    databases.pop();
    const reopened = openDatabase(directories[0]);
    expect(reopened.db.prepare("SELECT value FROM settings WHERE key = ?").get("runtime-probe")).toEqual({ value: "persisted" });
    expect(reopened.db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("loads the package binding for Electron without a version-specific cache", () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, "electron");
    Object.defineProperty(process.versions, "electron", { value: "999.0.0", configurable: true });
    try {
      expect(openDatabase().db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    } finally {
      if (original) Object.defineProperty(process.versions, "electron", original);
      else Reflect.deleteProperty(process.versions, "electron");
    }
  });
});
