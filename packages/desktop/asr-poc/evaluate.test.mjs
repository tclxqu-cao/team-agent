import assert from "node:assert/strict";
import test from "node:test";

import { characterScore, normalizeTranscript } from "./evaluate.mjs";

test("normalizeTranscript removes spacing and punctuation but keeps words", () => {
  assert.equal(normalizeTranscript(" 你好，小智！Open 2 个窗口。 "), "你好小智open2个窗口");
});

test("characterScore reports a hand-checked single substitution", () => {
  assert.deepEqual(characterScore("小智请打开窗口", "小志请打开窗口"), {
    accuracy: 0.8571,
    distance: 1,
    hypothesis: "小志请打开窗口",
    reference: "小智请打开窗口",
    referenceCharacters: 7,
  });
});

test("characterScore handles an empty recognition result", () => {
  assert.deepEqual(characterScore("测试", ""), {
    accuracy: 0,
    distance: 2,
    hypothesis: "",
    reference: "测试",
    referenceCharacters: 2,
  });
});
