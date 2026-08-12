#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import {
  cleanRecognizerText,
  Float32LeDecoder,
  MetricTracker,
  parseArgs,
} from "./lib.mjs";

const SAMPLE_RATE = 16_000;
const TAIL_PADDING_SAMPLES = SAMPLE_RATE * 0.4;

function findModelFiles(modelDir) {
  const absoluteDir = resolve(modelDir);
  if (!existsSync(absoluteDir) || !statSync(absoluteDir).isDirectory()) {
    throw new Error(`model directory does not exist: ${absoluteDir}`);
  }
  const names = readdirSync(absoluteDir);
  const find = (pattern) => {
    const name = names.find((candidate) => pattern.test(candidate));
    return name ? resolve(absoluteDir, name) : null;
  };
  const files = {
    decoder: find(/^decoder.*\.onnx$/),
    encoder: find(/^encoder.*\.onnx$/),
    joiner: find(/^joiner.*\.onnx$/),
    tokens: find(/^tokens\.txt$/),
  };
  const missing = Object.entries(files)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`model directory is missing: ${missing.join(", ")}`);
  }
  return files;
}

function ffmpegArgs(options) {
  const source = options.input
    ? ["-i", resolve(options.input)]
    : ["-f", "avfoundation", "-i", `:${options.microphone}`];
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    ...source,
    "-vn",
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "f32le",
    "pipe:1",
  ];
}

function reporter(json) {
  return (type, fields = {}) => {
    const event = { type, ...fields };
    if (json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    if (type === "partial") process.stdout.write(`\r${fields.text}`);
    else if (type === "final") process.stdout.write(`\r${fields.text}\n`);
    else process.stdout.write(`${type}: ${JSON.stringify(fields)}\n`);
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = findModelFiles(options.modelDir);
  if (options.input && !existsSync(resolve(options.input))) {
    throw new Error(`input audio file does not exist: ${resolve(options.input)}`);
  }

  const emit = reporter(options.json);
  const metrics = new MetricTracker(performance.now());
  const cpuStarted = process.cpuUsage();
  const require = createRequire(import.meta.url);
  const sherpa = require("sherpa-onnx-node");
  metrics.markAddonLoaded(performance.now());

  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        decoder: model.decoder,
        encoder: model.encoder,
        joiner: model.joiner,
      },
      tokens: model.tokens,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
    maxActivePaths: 4,
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  });
  metrics.markModelLoaded(performance.now());

  let stream = recognizer.createStream();
  let latestText = "";
  let stopped = false;
  const decoder = new Float32LeDecoder();

  const decodeReady = () => {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  };
  const currentText = () => cleanRecognizerText(recognizer.getResult(stream).text);
  const emitPartial = () => {
    const text = currentText();
    if (text && text !== latestText) {
      latestText = text;
      metrics.markPartial(performance.now());
      emit("partial", { text });
    }
  };
  const finishSegment = () => {
    stream.acceptWaveform({
      samples: new Float32Array(TAIL_PADDING_SAMPLES),
      sampleRate: SAMPLE_RATE,
    });
    decodeReady();
    const text = currentText();
    if (text) {
      metrics.markFinal(performance.now());
      emit("final", { text });
    }
    recognizer.reset(stream);
    latestText = "";
  };
  const accept = (samples) => {
    if (samples.length === 0) return;
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    decodeReady();
    emitPartial();
    if (recognizer.isEndpoint(stream)) finishSegment();
  };

  const ffmpeg = spawn("ffmpeg", ffmpegArgs(options), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  metrics.markAudioStarted(performance.now());
  emit("ready", {
    addonVersion: sherpa.version,
    input: options.input ?? `microphone:${options.microphone}`,
  });

  ffmpeg.stdout.on("data", (chunk) => accept(decoder.push(chunk)));
  let ffmpegError = "";
  ffmpeg.stderr.on("data", (chunk) => { ffmpegError += chunk.toString("utf8"); });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    ffmpeg.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const exitCode = await new Promise((resolveExit) => {
    ffmpeg.once("error", (error) => {
      ffmpegError += error.message;
      resolveExit(-1);
    });
    ffmpeg.once("close", resolveExit);
  });
  decoder.flush();
  stream.inputFinished();
  decodeReady();
  emitPartial();
  if (latestText) finishSegment();

  if (exitCode !== 0 && !stopped) {
    throw new Error(`FFmpeg failed (${exitCode}): ${ffmpegError.trim()}`);
  }
  const cpu = process.cpuUsage(cpuStarted);
  emit("metrics", {
    ...metrics.summary(),
    cpuMs: Math.round((cpu.user + cpu.system) / 1_000),
    rssMiB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
  });
}

main().catch((error) => {
  process.stderr.write(`ASR POC error: ${error.message}\n`);
  process.exitCode = 1;
});
