import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const directory = await realpath(process.argv[2] ? resolve(process.argv[2]) : join(repository, "packages/messaging"));
const entry = join(directory, "dist/index.js");
const source = await readFile(entry, "utf8");
assert.match(source, /from ["']@agent\/core["']/, "messaging must retain its external core dependency");
const messaging = await import(pathToFileURL(entry).href);
const require = createRequire(pathToFileURL(join(directory, "package.json")));
const core = await import(pathToFileURL(require.resolve("@agent/core")).href);
for (const name of ["reader.py", "codec.py", "native_sender.py", "NativeAXBridge.swift"]) {
  assert.ok((await stat(join(directory, "dist/assets/wecom", name))).isFile(), "missing channel asset: " + name);
  assert.ok(messaging.resolveWecomAsset(name).startsWith(directory + "/"), "channel asset must resolve within its own package: " + name);
}
const temporary = await mkdtemp(join(tmpdir(), "messaging-package-"));
try {
  const store = new messaging.SQLiteMessagingRepository(temporary);
  assert.equal(store.db, core.getDatabase(temporary).db, "package must use core's shared database instance");
  assert.deepEqual(store.list().counts, { total: 0, review: 0, running: 0, completed: 0, deliveryFailed: 0 });
  core.getDatabase(temporary).close();
} finally { await rm(temporary, { recursive: true, force: true }); }
console.log("messaging package: Node import, shared core singleton, clean database and channel assets passed");
