import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNTIME_TARGETS, validateNativeInventory } from "./runtime-native-files.mjs";

for (const target of Object.keys(RUNTIME_TARGETS)) {
  test(`${target} requires every platform sidecar instead of counting files`, () => {
    const nativeFiles = Object.fromEntries(RUNTIME_TARGETS[target].nativeFiles.map(file => [file, "a".repeat(64)]));
    const entries = Object.keys(nativeFiles).map(file => `package/runtime/${file}`);
    assert.doesNotThrow(() => validateNativeInventory({ target, nativeFiles }, entries));
    for (const file of Object.keys(nativeFiles)) {
      const incomplete = { ...nativeFiles };
      delete incomplete[file];
      assert.throws(() => validateNativeInventory({ target, nativeFiles: incomplete }, entries), /missing required file/);
    }
    assert.throws(() => validateNativeInventory({ target, nativeFiles }, entries.slice(1)), /missing inventoried native file/);
    assert.throws(() => validateNativeInventory({ target, nativeFiles: { ...nativeFiles, "../../injected.node": "a".repeat(64) } }, entries), /unexpected native file/);
    const first = Object.keys(nativeFiles)[0];
    assert.throws(() => validateNativeInventory({ target, nativeFiles: { ...nativeFiles, [first]: "invalid" } }, entries), /invalid native hash/);
  });
}
