import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("CLI rejects a model directory without recognizer files", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("./index.mjs", import.meta.url).pathname,
      "--model-dir", "/definitely/missing/sherpa-model",
      "--input", "/tmp/sample.wav",
    ],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /model directory does not exist/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
});
