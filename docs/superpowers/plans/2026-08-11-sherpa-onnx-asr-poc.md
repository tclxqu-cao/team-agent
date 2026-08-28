# Sherpa ONNX Chinese ASR POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and evaluate an isolated local streaming Chinese ASR POC without changing the desktop production voice path.

**Architecture:** A small Node ESM program starts FFmpeg for file or AVFoundation microphone input, converts streamed float PCM bytes into complete samples, and feeds the official sherpa-onnx online recognizer. Pure parsing and metrics logic stays dependency-free and unit tested; native dependencies and models remain local ignored artifacts.

**Tech Stack:** Node.js ESM, `node:test`, FFmpeg 8, `sherpa-onnx-node@1.13.4`, streaming Zipformer Chinese INT8 model.

## Global Constraints

- Do not modify `packages/desktop/native/wakelistener.swift` or any production IPC/renderer path.
- Do not stage `packages/server/.next/**`, `.agents/`, model files, generated audio, or POC `node_modules`.
- Pin sherpa packages to `1.13.4`; do not use the incomplete `1.13.5` macOS dependency set.
- Record measured startup cost instead of assuming local inference has no warm-up.

---

### Task 1: Pure POC Core

**Files:**
- Create: `packages/desktop/asr-poc/lib.mjs`
- Test: `packages/desktop/asr-poc/lib.test.mjs`

**Interfaces:**
- Produces: `parseArgs(argv)`, `Float32LeDecoder.push(chunk)`, `Float32LeDecoder.flush()`, and `Metrics`.

- [x] Write failing `node:test` cases for mutually exclusive inputs, required model directory, split float samples across chunks, trailing-byte rejection, and first/final latency values.
- [x] Run `node --test packages/desktop/asr-poc/lib.test.mjs` and verify failure because `lib.mjs` does not exist.
- [x] Implement only the tested argument, PCM, and metric behavior.
- [x] Re-run the focused test and verify all cases pass.

### Task 2: Streaming Recognizer CLI

**Files:**
- Create: `packages/desktop/asr-poc/package.json`
- Create: `packages/desktop/asr-poc/index.mjs`
- Create: `packages/desktop/asr-poc/run.sh`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 1 core helpers and sherpa `OnlineRecognizer`.
- Produces: file and microphone CLI with human or JSON events.

- [x] Add a failing integration test that invokes `index.mjs` with an invalid model directory and asserts the actionable error and non-zero exit.
- [x] Run the integration test and verify the missing CLI causes the expected failure.
- [x] Add the isolated package, pinned dependency, explicit dynamic-library wrapper, model validation, FFmpeg source, decode loop, endpoint reset, metrics output, signal cleanup, and ignored local artifacts.
- [x] Install dependencies inside `packages/desktop/asr-poc`, run unit/integration tests, and verify the native addon loads under Node.

### Task 3: Model and Deterministic Audio Validation

**Files:**
- Create: `packages/desktop/asr-poc/download-model.sh`
- Create: `packages/desktop/asr-poc/README.md`
- Create: `packages/desktop/asr-poc/evaluate.mjs`

**Interfaces:**
- Consumes: Task 2 JSON event stream.
- Produces: repeatable fixed-phrase accuracy and runtime summary.

- [x] Add a failing test for evaluation normalization and exact-character accuracy calculations.
- [x] Implement the evaluator, explicit checksum-aware model downloader, and reproducible commands.
- [x] Download the streaming Zipformer Chinese INT8 model to `.agent-data`, generate fixed Tingting audio, run the evaluator, and capture startup/latency/RSS/CPU/transcript results.

### Task 4: Live Microphone and Electron Compatibility Evidence

**Files:**
- Modify: `packages/desktop/asr-poc/README.md`

**Interfaces:**
- Consumes: Task 2 microphone mode and Task 3 measurement format.
- Produces: go/no-go recommendation for product integration.

- [x] Enumerate AVFoundation devices and run the POC against the active microphone.
- [x] Run the addon with Electron 32's Node runtime or a minimal Electron main-process probe to verify Node-API compatibility separately from microphone TCC.
- [x] Compare measured quality, punctuation, latency, CPU/RSS, startup, native loading, and TCC behavior with the current Swift helper evidence.
- [x] Document the recommended next migration boundary: Electron addon, Swift PCM sidecar, or retain SFSpeechRecognizer.
