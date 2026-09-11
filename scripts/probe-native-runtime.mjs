import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteDatabase } from "../packages/core/dist/index.js";
import { probeSQLiteRuntime, probeTerminalRuntime } from "../packages/cli/dist/native-runtime.js";
import { assertSupportedNodeVersion } from "../packages/cli/bin/runtime-policy.mjs";

assertSupportedNodeVersion();
const runtimeRequire = createRequire(new URL("../packages/server/package.json", import.meta.url));
probeSQLiteRuntime(runtimeRequire);
await probeTerminalRuntime(runtimeRequire);
const directory = mkdtempSync(join(tmpdir(), "agentroam-node-api-"));
let database;
try {
  database = new SQLiteDatabase(directory);
  database.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("probe", "persisted");
  assert.throws(database.db.transaction(() => {
    database.db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("rollback", "probe");
    throw new Error("abort transaction");
  }), /abort transaction/);
  database.close();
  database = new SQLiteDatabase(directory);
  assert.equal(database.db.prepare("SELECT value FROM settings WHERE key = ?").get("probe").value, "persisted");
  assert.equal(database.db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(database.db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(database.db.pragma("integrity_check", { simple: true }), "ok");
  const nativeFiles = Object.keys(runtimeRequire.cache).filter(file => file.endsWith(".node"));
  console.log(JSON.stringify({
    node: process.versions.node, electron: process.versions.electron, nodeApi: process.versions.napi,
    sqlite: "read/write/rollback/reopen passed", pty: "spawn/output/exit passed",
    nativeFiles: Object.fromEntries(nativeFiles.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])),
  }, null, 2));
} finally {
  database?.close();
  rmSync(directory, { recursive: true, force: true });
}
