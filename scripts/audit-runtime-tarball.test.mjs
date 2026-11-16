import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const retired of [
  "runtime/node_modules/@agent/messaging/dist/index.js",
  "runtime/native/Support.noindex/WeComSendBridge.app/Contents/MacOS/NativeAXBridge",
]) {
  test(`rejects a runtime carrying retired payload ${retired}`, async t => {
    const directory = await mkdtemp(resolve(tmpdir(), "retired-runtime-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = resolve(directory, "package", retired);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "retired payload");
    const tarball = resolve(directory, "runtime.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", directory, "package"]);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./audit-runtime-tarball.mjs", import.meta.url)), tarball], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retired messaging runtime artifacts/);
    assert.ok(result.stderr.includes(retired));
  });
}
