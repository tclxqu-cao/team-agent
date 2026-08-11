# Local and Remote Voice Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a reusable local/remote sherpa-onnx voice service and connect the desktop application to low-latency streaming Chinese ASR, offline Chinese TTS, wake, dictation, multi-turn conversation, and immediate barge-in.

**Architecture:** A standalone Node HTTP/WebSocket service owns long-lived sherpa ASR/TTS engines. Swift keeps microphone capture, resampling, VAD, AEC, and barge-in; Electron forwards binary PCM through a generation-aware client and reuses the existing renderer contracts. Remote, localhost, and native providers form an ordered fallback chain.

**Tech Stack:** TypeScript, Node.js HTTP, `ws`, `sherpa-onnx-node@1.13.4`, Electron 32, Swift 5, AVFoundation, Vitest.

## Global Constraints

- Use `sherpa-onnx-node@1.13.4` exactly; do not upgrade to 1.13.5.
- ASR model is `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` with `encoder.int8.onnx`, `decoder.onnx`, `joiner.int8.onnx`, and `tokens.txt`.
- TTS model is the official sherpa-onnx `vits-melo-tts-zh_en` archive.
- Model files remain ignored and are never committed or downloaded implicitly.
- Swift external-ASR output is mono 16,000 Hz float32 little-endian PCM.
- Preserve barge-in peak 0.10, RMS 0.02, sustained duration 0.25 seconds, and normal speech peak 0.009.
- Preserve `wake:trigger`, `wake:command`, `dictation:result`, `dictation:error`, `tts:start`, and `tts:end` renderer events.
- Do not modify or stage `packages/server/.next/**`, `.agents/`, or model files.
- This project does not run `git-ai` per the user's explicit instruction.

---

### Task 1: Voice Service Protocol and Configuration

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `packages/voice-service/package.json`
- Create: `packages/voice-service/tsconfig.json`
- Create: `packages/voice-service/src/protocol.ts`
- Create: `packages/voice-service/src/config.ts`
- Test: `packages/voice-service/src/protocol.test.ts`
- Test: `packages/voice-service/src/config.test.ts`

**Interfaces:**
- Produces: `parseAsrControl(raw: string): AsrControl`, `parseTtsRequest(raw: unknown): TtsRequest`, `resolveVoiceServiceConfig(env, cwd): VoiceServiceConfig`.
- Produces exact event types carrying `sessionId`, `generation`, and optional `utteranceId`.

- [ ] **Step 1: Write failing protocol tests**

Cover a valid `start`, `reset`, `finish`, and `stop`; reject binary-before-start, non-16k sample rates, missing session IDs, negative generations, empty TTS text, text over 600 characters, and speed outside 0.5 through 2.0. Expected values are literal objects.

- [ ] **Step 2: Run the tests and verify RED**

Run: `bunx vitest run packages/voice-service/src/protocol.test.ts packages/voice-service/src/config.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement protocol and configuration parsing**

Use discriminated unions for controls and events. Resolve `VOICE_SERVICE_PORT` to integer `17863`, reject non-loopback binds without `VOICE_SERVICE_TOKEN`, and resolve model directories from explicit environment variables before ignored development defaults.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bunx vitest run packages/voice-service/src/protocol.test.ts packages/voice-service/src/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Add the workspace and pinned dependencies**

Add `packages/voice-service` to root workspaces. Add exact `sherpa-onnx-node: 1.13.4`, `ws`, and `@types/ws` to the new package, then run `bun install` and verify the Darwin arm64 addon remains at 1.13.4 in `bun.lock`.

### Task 2: Streaming ASR Engine and WebSocket Server

**Files:**
- Create: `packages/voice-service/src/model-files.ts`
- Create: `packages/voice-service/src/asr-engine.ts`
- Create: `packages/voice-service/src/server.ts`
- Create: `packages/voice-service/src/main.ts`
- Test: `packages/voice-service/src/model-files.test.ts`
- Test: `packages/voice-service/src/asr-engine.test.ts`
- Test: `packages/voice-service/src/server.test.ts`

**Interfaces:**
- Consumes: protocol and configuration from Task 1.
- Produces: `AsrEngine.createSession()`, session `acceptPcm`, `finish`, `reset`, and `close` methods.
- Produces: `createVoiceServer(options): Promise<VoiceServer>` with `url`, `close()`, and `/health`.

- [ ] **Step 1: Write failing model and ASR session tests**

Validate the four required Zipformer files by actual temporary directory contents. Use a deterministic fake recognizer at the sherpa boundary and assert that changed partials emit once, endpoint finals include increasing literal utterance IDs, `finish` flushes non-empty text, reset clears the hypothesis, and close releases the stream.

- [ ] **Step 2: Verify the ASR tests fail for missing implementation**

Run: `bunx vitest run packages/voice-service/src/model-files.test.ts packages/voice-service/src/asr-engine.test.ts`

Expected: FAIL because production modules are absent.

- [ ] **Step 3: Implement the long-lived Zipformer engine**

Create one `OnlineRecognizer` with two CPU threads, greedy search, endpoint detection, 2.4-second rule 1, 0.8-second rule 2, and 20-second rule 3. Each socket owns only its decoder stream. Remove `U+FFFD`, suppress unchanged partials, append 0.4 seconds of silence on explicit finish, and reset after every endpoint.

- [ ] **Step 4: Write and verify failing WebSocket integration tests**

Start a real ephemeral HTTP server with the fake engine. Assert `/health`, Bearer rejection, required `start`, binary PCM delivery, partial/final JSON, reset, stale control rejection, and per-socket isolation.

Run: `bunx vitest run packages/voice-service/src/server.test.ts`

Expected: FAIL before the server exists.

- [ ] **Step 5: Implement HTTP health and `WS /v1/asr`**

Keep binary audio and JSON controls distinct. Cap binary frames at 256 KiB, validate complete float32 samples, and close malformed sessions with a structured error. Do not log audio or transcript content.

- [ ] **Step 6: Run the service test suite**

Run: `bunx vitest run packages/voice-service/src`

Expected: PASS with no open-handle warning.

### Task 3: Offline TTS and Cancellable WAV Response

**Files:**
- Create: `packages/voice-service/src/wav.ts`
- Create: `packages/voice-service/src/tts-engine.ts`
- Test: `packages/voice-service/src/wav.test.ts`
- Test: `packages/voice-service/src/tts-engine.test.ts`
- Modify: `packages/voice-service/src/server.ts`
- Modify: `packages/voice-service/src/server.test.ts`

**Interfaces:**
- Produces: `encodeFloat32Wav(samples, sampleRate): Buffer`.
- Produces: `TtsEngine.generate(request, signal): Promise<{ wav: Buffer; sampleRate: number }>`.
- Produces: authenticated `POST /v1/tts` returning `audio/wav` and `X-Voice-Generation`.

- [ ] **Step 1: Write failing WAV and TTS tests**

Assert literal RIFF/WAVE fields, PCM float format code 3, channel count 1, sample rate, byte rate, and data length. With a fake offline TTS, assert voice/speed mapping, serialized generation, abort propagation, and no second synthesis after cancellation.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bunx vitest run packages/voice-service/src/wav.test.ts packages/voice-service/src/tts-engine.test.ts`

Expected: FAIL because WAV and TTS modules do not exist.

- [ ] **Step 3: Implement VITS discovery and asynchronous generation**

Discover `model.onnx`, `tokens.txt`, optional `lexicon.txt`, and optional `dict` data directory. Load through `OfflineTts.createAsync`; call `generateAsync` with `sid: 0` and request speed. Return float WAV and stop progress when the abort signal is set.

- [ ] **Step 4: Add failing HTTP TTS tests**

Assert 400 for invalid requests, 401 for bad tokens, 503 when TTS is unavailable, 200 WAV for success, correct generation header, and client disconnect cancellation.

- [ ] **Step 5: Implement `POST /v1/tts` and verify GREEN**

Run: `bunx vitest run packages/voice-service/src/server.test.ts packages/voice-service/src/tts-engine.test.ts packages/voice-service/src/wav.test.ts`

Expected: PASS.

### Task 4: Desktop Voice Service Client and Provider Fallback

**Files:**
- Create: `packages/desktop/main/voice-service-client.ts`
- Create: `packages/desktop/main/voice-service-client.test.ts`
- Create: `packages/desktop/main/voice-service-manager.ts`
- Create: `packages/desktop/main/voice-service-manager.test.ts`
- Modify: `packages/desktop/package.json`

**Interfaces:**
- Produces: `VoiceServiceClient` with `startAsr`, `sendPcm`, `finishAsr`, `stopAsr`, and `synthesize`.
- Produces: `VoiceServiceManager.connect()` selecting remote, managed localhost, or native fallback and `close()` terminating only managed processes.
- Emits only current-generation partial/final events.

- [ ] **Step 1: Write failing client generation tests**

Use a real ephemeral WebSocket/HTTP fixture. Assert start handshake, binary forwarding, partial/final mapping to existing `TEXT`/`FINAL` semantics, remote token headers, explicit reset, TTS WAV bytes, abort, and rejection of a late event from generation N after generation N+1 starts.

- [ ] **Step 2: Run tests and verify RED**

Run: `bunx vitest run packages/desktop/main/voice-service-client.test.ts packages/desktop/main/voice-service-manager.test.ts`

Expected: FAIL because client and manager do not exist.

- [ ] **Step 3: Implement client and provider selection**

Use `ws` in the Electron main process. Convert configured `http/https` URLs to `ws/wss` only for ASR. Wait for `ready` before forwarding PCM. On remote readiness failure, invalidate the generation and try localhost. On local failure, return a typed native-fallback result.

- [ ] **Step 4: Implement managed localhost lifecycle**

Launch the compiled service with `process.execPath`, `ELECTRON_RUN_AS_NODE=1`, loopback host, configured model paths, and piped diagnostics. Poll `/health` with a bounded timeout, restart unexpectedly exited managed processes with bounded backoff, and terminate them on manager close.

- [ ] **Step 5: Run focused tests and desktop compilation**

Run: `bunx vitest run packages/desktop/main/voice-service-client.test.ts packages/desktop/main/voice-service-manager.test.ts`

Run: `bun run --cwd packages/voice-service build && bun run --cwd packages/desktop compile`

Expected: both commands PASS.

### Task 5: Swift Continuous PCM Capture

**Files:**
- Modify: `packages/desktop/native/wakelistener.swift`
- Rebuild: `packages/desktop/native/wakelistener`
- Create: `packages/desktop/native/wakelistener-contract.test.ts`

**Interfaces:**
- Consumes mode argument `external-wake`, `external-dictation`, or `external-barge-in`.
- Produces raw stdout PCM and stderr controls `READY`, `BARGE_IN`, `HB`, and `ERROR`.
- Keeps existing native `wake`, `dictation`, and `barge-in` behavior intact.

- [ ] **Step 1: Write a failing executable contract test**

Compile the helper to a temporary path and run a no-device diagnostic argument that feeds a deterministic 48 kHz stereo buffer through the same converter. Assert stdout length is divisible by four, output is 16 kHz mono float32, stderr contains only protocol lines, and external mode does not request Speech authorization.

- [ ] **Step 2: Run the contract test and verify RED**

Run: `bunx vitest run packages/desktop/native/wakelistener-contract.test.ts`

Expected: FAIL because external mode and the converter diagnostic do not exist.

- [ ] **Step 3: Implement external capture mode**

Separate `emitControl` from binary output. Use `AVAudioConverter` from the hardware format to mono 16 kHz float32, copy converted bytes off the real-time callback, and serialize stdout writes on a dedicated queue. Keep VAD calculations on the original channel and all current barge-in thresholds.

- [ ] **Step 4: Skip Speech authorization in external mode**

Request microphone access through AVFoundation only. Start one continuous engine rather than writing CAF files or restarting after each endpoint. Retain native recognition functions unchanged for fallback arguments.

- [ ] **Step 5: Verify and rebuild**

Run: `bunx vitest run packages/desktop/native/wakelistener-contract.test.ts`

Run: `swiftc -swift-version 5 -O -framework Speech -framework AVFoundation packages/desktop/native/wakelistener.swift -o packages/desktop/native/wakelistener`

Expected: test and compilation PASS.

### Task 6: Wake, Dictation, Multi-Turn, TTS, and Barge-In Integration

**Files:**
- Modify: `packages/desktop/main/voice-capture-state.ts`
- Modify: `packages/desktop/main/voice-capture-state.test.ts`
- Modify: `packages/desktop/main/index.ts`

**Interfaces:**
- Consumes `VoiceServiceManager` and Swift external PCM/control streams.
- Preserves all renderer IPC and existing native fallback modes.
- Produces generation-safe ASR routing and cancellable VITS audio playback through `afplay`.

- [ ] **Step 1: Write failing state tests for stale and second-turn behavior**

Assert current-generation acceptance, stale-generation rejection, one final per utterance ID, mode switch invalidation, barge-in TTS invalidation, and a second conversation final producing a new command without another wake word.

- [ ] **Step 2: Run the state tests and verify RED**

Run: `bunx vitest run packages/desktop/main/voice-capture-state.test.ts`

Expected: FAIL because generation and utterance guards do not exist.

- [ ] **Step 3: Add pure generation guards and verify GREEN**

Implement immutable helpers in `voice-capture-state.ts`, then rerun the focused state tests until they pass before changing `index.ts`.

- [ ] **Step 4: Route Swift PCM through the voice client**

Launch external Swift modes whenever the manager selects service ASR. Pipe stdout chunks to `sendPcm`; parse stderr controls separately. Map service partial/final events into the existing transcript handler. On manager fallback, terminate external capture before launching the native helper.

- [ ] **Step 5: Replace primary `say` playback with service TTS**

On `tts:speak`, abort the prior synthesis, request current-generation WAV, write it to an app-owned temporary file, and spawn `afplay`. Delete the file after exit. If synthesis fails, use the existing `say` path for the same generation.

- [ ] **Step 6: Make barge-in cancellation atomic**

On `BARGE_IN`, advance TTS generation first, abort HTTP generation, kill `afplay` or `say`, delete pending audio, emit `tts:end` once, and retain the active ASR capture so the same speech becomes the next command.

- [ ] **Step 7: Run regression tests and compile**

Run: `bunx vitest run packages/desktop/main/voice-capture-state.test.ts packages/desktop/main/voice-service-client.test.ts packages/desktop/main/voice-service-manager.test.ts`

Run: `bun run --cwd packages/desktop compile`

Expected: PASS without TypeScript errors.

### Task 7: Real Models, End-to-End Validation, and Delivery

**Files:**
- Modify: `.gitignore`
- Create: `packages/voice-service/scripts/download-tts-model.sh`
- Create: `packages/voice-service/README.md`
- Modify: `docs/superpowers/plans/2026-08-11-local-remote-voice-service.md`

**Interfaces:**
- Produces an explicit checksum-aware TTS model installation command.
- Produces reproducible local and remote service startup commands.

- [ ] **Step 1: Add explicit model installation and documentation**

Pin `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2` and its verified SHA-256 in the download script. Install only on explicit invocation under `.agent-data/tts-models/vits-melo-tts-zh_en`. Document environment variables, local startup, remote TLS/token deployment, health checks, and licensing caveats.

- [ ] **Step 2: Run all automated verification**

Run: `bunx vitest run packages/voice-service/src packages/desktop/main packages/desktop/native/wakelistener-contract.test.ts`

Run: `bun run --cwd packages/voice-service build && bun run --cwd packages/desktop build`

Run: `git diff --check`

Expected: all commands PASS.

- [ ] **Step 3: Validate real ASR and TTS engines**

Start the service against the ignored Zipformer and VITS directories. Confirm `/health` reports ASR and TTS ready. Send deterministic Chinese audio and compare the literal normalized transcript. Submit Chinese text to `/v1/tts`, confirm a non-empty valid WAV, and play it through `afplay`.

- [ ] **Step 4: Launch the desktop through LaunchServices**

Start the desktop application with TCC attributed to Electron. Verify hidden wake, first command, input dictation, AI TTS, spoken barge-in, second and third no-wake turns, and restart after remote endpoint failure. Capture timestamps for speech onset, first partial, final, TTS stop, and next submission.

- [ ] **Step 5: Review the final diff and commit only scoped files**

Exclude `.next`, `.agents`, model weights, generated WAV/PCM, and POC `node_modules`. Commit implementation and tests on `feature_req_voice_input_wake_word_tts_skin_layout_cq_260804`, then push that branch without running `git-ai` as explicitly requested.

- [ ] **Step 6: Capture reusable findings and notify**

Use `wiki-capture` to update the existing macOS voice-wake page with the final architecture, model/runtime constraints, protocol, latency, and verification results. Resolve the enterprise WeChat recipient from the wiki, then use `wecomcli-msg` to send the completion summary and branch/commit information.
