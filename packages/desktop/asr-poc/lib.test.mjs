import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanRecognizerText,
  Float32LeDecoder,
  MetricTracker,
  parseArgs,
} from "./lib.mjs";

test("parseArgs requires a model directory", () => {
  assert.throws(
    () => parseArgs(["--input", "sample.wav"]),
    /--model-dir is required/,
  );
});

test("parseArgs requires exactly one audio source", () => {
  assert.throws(
    () => parseArgs(["--model-dir", "model"]),
    /exactly one of --input or --microphone/,
  );
  assert.throws(
    () => parseArgs([
      "--model-dir", "model",
      "--input", "sample.wav",
      "--microphone", "2",
    ]),
    /exactly one of --input or --microphone/,
  );
});

test("parseArgs preserves file and JSON options", () => {
  assert.deepEqual(
    parseArgs(["--model-dir", "model", "--input", "sample.aiff", "--json"]),
    {
      input: "sample.aiff",
      json: true,
      microphone: null,
      modelDir: "model",
    },
  );
});

test("Float32LeDecoder preserves samples split across byte chunks", () => {
  const source = Buffer.alloc(12);
  source.writeFloatLE(0.25, 0);
  source.writeFloatLE(-0.5, 4);
  source.writeFloatLE(1, 8);

  const decoder = new Float32LeDecoder();
  assert.deepEqual([...decoder.push(source.subarray(0, 5))], [0.25]);
  assert.deepEqual([...decoder.push(source.subarray(5))], [-0.5, 1]);
  decoder.flush();
});

test("Float32LeDecoder rejects an incomplete final sample", () => {
  const decoder = new Float32LeDecoder();
  decoder.push(Buffer.from([0, 0, 0]));
  assert.throws(() => decoder.flush(), /3 trailing PCM bytes/);
});

test("cleanRecognizerText hides invalid replacement characters in partial text", () => {
  assert.equal(cleanRecognizerText(" 帮我查�询 "), "帮我查询");
});

test("MetricTracker measures model, first partial, and final latency", () => {
  const metrics = new MetricTracker(1_000);
  metrics.markAddonLoaded(1_040);
  metrics.markModelLoaded(1_400);
  metrics.markAudioStarted(2_000);
  metrics.markPartial(2_180);
  metrics.markPartial(2_300);
  metrics.markFinal(2_650);

  assert.deepEqual(metrics.summary(), {
    addonLoadMs: 40,
    firstPartialMs: 180,
    finalMs: 650,
    modelLoadMs: 360,
  });
});

test("MetricTracker reports null speech latency when no text is recognized", () => {
  const metrics = new MetricTracker(1_000);
  metrics.markAddonLoaded(1_040);
  metrics.markModelLoaded(1_400);
  metrics.markAudioStarted(2_000);

  assert.deepEqual(metrics.summary(), {
    addonLoadMs: 40,
    firstPartialMs: null,
    finalMs: null,
    modelLoadMs: 360,
  });
});
