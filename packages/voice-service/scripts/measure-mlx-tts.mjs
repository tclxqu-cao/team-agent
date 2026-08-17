#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FrameDecoder } from "../dist/framed-process.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const python = process.env.VOICE_TTS_PYTHON
  ?? join(repoRoot, "packages/desktop/.agent-data/tts-runtime/bin/python");
const worker = process.env.VOICE_TTS_WORKER_SCRIPT
  ?? join(repoRoot, "packages/voice-service/python/mlx_tts_worker.py");
const model = process.env.VOICE_TTS_MODEL
  ?? "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
const voice = process.env.VOICE_TTS_VOICE ?? "Serena";
const interval = Number(process.env.VOICE_TTS_STREAMING_INTERVAL ?? "0.32");
const texts = [
  "你好，我是小智。",
  "这是一次较长的本地流式语音测试，用来确认模型不会等到整段内容全部合成完毕以后才开始播放，同时验证连续输出、停止播报以及下一轮语音恢复是否稳定。过程必须保持声音自然流畅并且能够随时被用户打断。",
];

class Inbox {
  values = [];
  waiters = [];

  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  next() {
    const value = this.values.shift();
    if (value) return Promise.resolve(value);
    return new Promise((resolveNext) => this.waiters.push(resolveNext));
  }
}

function physicalFootprint(pid) {
  try {
    const output = execFileSync("vmmap", ["-summary", String(pid)], { encoding: "utf8" });
    return output.split("\n").find((line) => line.trim().startsWith("Physical footprint:"))?.trim() ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const launchedAt = performance.now();
  const child = spawn(python, ["-u", worker, "--model", model], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const decoder = new FrameDecoder();
  const inbox = new Inbox();
  child.stdout.on("data", (chunk) => {
    for (const frame of decoder.push(chunk)) inbox.push(frame);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.once("exit", (code, signal) => {
    inbox.push({ kind: "exit", payload: Buffer.from(`${signal ?? code}`) });
  });

  const ready = await inbox.next();
  if (ready.kind !== "json") throw new Error("worker exited before ready");
  const readyMessage = JSON.parse(ready.payload.toString());
  if (readyMessage.type !== "ready") throw new Error(readyMessage.message ?? "worker failed to start");
  const coldReadyMs = performance.now() - launchedAt;
  const idlePhysicalFootprint = physicalFootprint(child.pid);
  const measurements = [];

  for (let index = 0; index < texts.length; index += 1) {
    const requestId = `measure-${index + 1}`;
    const startedAt = performance.now();
    child.stdin.write(`${JSON.stringify({
      type: "synthesize",
      requestId,
      text: texts[index],
      voice,
      speed: 1,
      streamingInterval: interval,
    })}\n`);
    let metadataMs = null;
    let firstPcmMs = null;
    let pcmBytes = 0;
    while (true) {
      const frame = await inbox.next();
      if (frame.kind === "exit") throw new Error(`worker exited: ${frame.payload.toString()}`);
      if (frame.kind === "pcm") {
        if (firstPcmMs === null) firstPcmMs = performance.now() - startedAt;
        pcmBytes += frame.payload.length;
        continue;
      }
      const message = JSON.parse(frame.payload.toString());
      if (message.requestId !== requestId) continue;
      if (message.type === "started") metadataMs = performance.now() - startedAt;
      if (message.type === "error") throw new Error(message.message);
      if (message.type === "finished") break;
    }
    if (metadataMs === null || firstPcmMs === null) {
      throw new Error(`measurement ${requestId} completed without streaming metadata or PCM`);
    }
    measurements.push({
      characters: texts[index].length,
      metadataMs: Math.round(metadataMs),
      firstPcmMs: Math.round(firstPcmMs),
      completedMs: Math.round(performance.now() - startedAt),
      pcmBytes,
      audioSeconds: Math.round((pcmBytes / 2 / 24_000) * 100) / 100,
      physicalFootprint: physicalFootprint(child.pid),
    });
  }

  const cancellationRequestId = "measure-cancel";
  const cancellationStartedAt = performance.now();
  child.stdin.write(`${JSON.stringify({
    type: "synthesize",
    requestId: cancellationRequestId,
    text: texts[1],
    voice,
    speed: 1,
    streamingInterval: interval,
  })}\n`);
  let cancelSentAt = null;
  let cancellationPcmBytes = 0;
  while (true) {
    const frame = await inbox.next();
    if (frame.kind === "exit") throw new Error(`worker exited: ${frame.payload.toString()}`);
    if (frame.kind === "pcm") {
      cancellationPcmBytes += frame.payload.length;
      if (cancelSentAt === null) {
        cancelSentAt = performance.now();
        child.stdin.write(`${JSON.stringify({ type: "cancel", requestId: cancellationRequestId })}\n`);
      }
      continue;
    }
    const message = JSON.parse(frame.payload.toString());
    if (message.requestId !== cancellationRequestId) continue;
    if (message.type === "error") throw new Error(message.message);
    if (message.type === "cancelled") break;
  }
  if (cancelSentAt === null) throw new Error("cancellation measurement received no PCM");
  const cancellation = {
    firstPcmMs: Math.round(cancelSentAt - cancellationStartedAt),
    cancelAckMs: Math.round(performance.now() - cancelSentAt),
    pcmBytesBeforeAck: cancellationPcmBytes,
  };

  const recoveryRequestId = "measure-recovery";
  const recoveryStartedAt = performance.now();
  child.stdin.write(`${JSON.stringify({
    type: "synthesize",
    requestId: recoveryRequestId,
    text: texts[0],
    voice,
    speed: 1,
    streamingInterval: interval,
  })}\n`);
  let recoveryFirstPcmMs = null;
  let recoveryPcmBytes = 0;
  while (true) {
    const frame = await inbox.next();
    if (frame.kind === "exit") throw new Error(`worker exited: ${frame.payload.toString()}`);
    if (frame.kind === "pcm") {
      if (recoveryFirstPcmMs === null) recoveryFirstPcmMs = performance.now() - recoveryStartedAt;
      recoveryPcmBytes += frame.payload.length;
      continue;
    }
    const message = JSON.parse(frame.payload.toString());
    if (message.requestId !== recoveryRequestId) continue;
    if (message.type === "error") throw new Error(message.message);
    if (message.type === "finished") break;
  }
  if (recoveryFirstPcmMs === null) throw new Error("recovery measurement received no PCM");
  const recovery = {
    firstPcmMs: Math.round(recoveryFirstPcmMs),
    completedMs: Math.round(performance.now() - recoveryStartedAt),
    pcmBytes: recoveryPcmBytes,
  };

  process.stdout.write(`${JSON.stringify({
    model,
    voice,
    interval,
    pid: child.pid,
    coldReadyMs: Math.round(coldReadyMs),
    idlePhysicalFootprint,
    measurements,
    cancellation,
    recovery,
  }, null, 2)}\n`);
  child.stdin.write('{"type":"shutdown"}\n');
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
