# Sherpa KWS Wake-Word Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace transcript-based detection of the default `小智` wake word with sherpa-onnx dedicated Chinese keyword spotting, then switch the same audio session to Zipformer command transcription.

**Architecture:** `packages/voice-service` loads the official WenetSpeech 3.3M KWS model beside the existing ASR/TTS engines. A `wake` WebSocket session uses KWS until it emits a generation-safe `keyword`, then swaps to a fresh Zipformer stream; dictation, conversation, and barge-in keep using Zipformer. Missing KWS assets and non-default wake words explicitly fall back to the current transcript matcher.

**Tech Stack:** TypeScript, Node.js HTTP/WebSocket, `sherpa-onnx-node@1.13.4`, Electron 32, Swift AVFoundation, Vitest.

## Global Constraints

- Keep `sherpa-onnx-node@1.13.4` pinned.
- KWS model is `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`.
- Model files remain Git-ignored and are installed only by an explicit checksum-aware script.
- Preserve remote service -> managed localhost -> native macOS provider order.
- Preserve renderer IPC for wake, commands, dictation, TTS, conversation, and barge-in.
- Every ASR/KWS result is guarded by `sessionId + generation`; keyword detection is emitted once per KWS stream.
- Do not modify or stage `packages/server/.next/**`, `.agents/`, `packages/desktop/asr-poc/`, or the existing untracked 2026-08-11 ASR POC documents.
- This project does not execute `git-ai`, per the user's explicit instruction.

---

### Task 1: KWS Configuration and Model Discovery

**Files:**
- Modify: `packages/voice-service/src/config.ts`
- Modify: `packages/voice-service/src/config.test.ts`
- Modify: `packages/voice-service/src/model-files.ts`
- Modify: `packages/voice-service/src/model-files.test.ts`

**Interfaces:**
- Produces `VoiceServiceConfig.kwsModelDir: string`.
- Produces `findKwsModelFiles(modelDir): { encoder; decoder; joiner; tokens; keywords }`.

- [ ] **Step 1: Write failing tests** asserting default and `VOICE_KWS_MODEL_DIR` paths, successful discovery of encoder/decoder/joiner/tokens/keywords, and an error listing every missing component.
- [ ] **Step 2: Verify RED** with `PATH=/Users/caoqu/.bun/bin:$PATH bunx vitest run packages/voice-service/src/config.test.ts packages/voice-service/src/model-files.test.ts`; failures must be missing `kwsModelDir` and `findKwsModelFiles` behavior.
- [ ] **Step 3: Implement the minimal config and discovery functions**, preferring int8 encoder/joiner when both variants exist and requiring `keywords.txt`.
- [ ] **Step 4: Verify GREEN** with the same command.

### Task 2: Dedicated Keyword Engine

**Files:**
- Create: `packages/voice-service/src/kws-engine.ts`
- Create: `packages/voice-service/src/kws-engine.test.ts`
- Modify: `packages/voice-service/src/sherpa-runtime.ts`
- Modify: `packages/voice-service/src/sherpa-runtime.test.ts`

**Interfaces:**
- Produces `KwsEngine.createSession(sessionId, generation, emit): KwsSession`.
- `KwsSession.acceptPcm(samples)` emits `{ type: "keyword", sessionId, generation, keyword }` once, resets immediately, and can be closed.
- `createSherpaEngines()` returns `kws`, `kwsError`, `asr`, `tts`, and `ttsError`; KWS failure is non-fatal.

- [ ] **Step 1: Write a failing fake-spotter test** where `getResult()` becomes `{ keyword: "小智" }` after decode; assert no empty event, exactly one current-generation event, reset after detection, and close calls `inputFinished()`.
- [ ] **Step 2: Verify RED** with `PATH=/Users/caoqu/.bun/bin:$PATH bunx vitest run packages/voice-service/src/kws-engine.test.ts`.
- [ ] **Step 3: Implement `KwsEngine`** using the same 16 kHz waveform contract as ASR and suppress duplicate keyword events until a fresh session is created.
- [ ] **Step 4: Extend sherpa runtime tests first** to require `KeywordSpotter` construction with the WenetSpeech transducer files, `maxActivePaths: 4`, `numTrailingBlanks: 1`, `keywordsScore: 1`, `keywordsThreshold: 0.25`, and `keywordsFile`.
- [ ] **Step 5: Verify the runtime test fails**, then implement non-fatal KWS loading in `createSherpaEngines()`.
- [ ] **Step 6: Verify GREEN** for both KWS and runtime tests.

### Task 3: Generation-Safe KWS WebSocket Protocol

**Files:**
- Modify: `packages/voice-service/src/protocol.ts`
- Modify: `packages/voice-service/src/protocol.test.ts`
- Modify: `packages/voice-service/src/server.ts`
- Modify: `packages/voice-service/src/server.test.ts`
- Modify: `packages/voice-service/src/main.ts`

**Interfaces:**
- `start` accepts optional `wakeWord` only as a string.
- `ready` reports `strategy: "kws" | "asr"`.
- `VoiceServiceEvent` gains `{ type: "keyword"; sessionId; generation; keyword }`.
- `createVoiceServer()` accepts optional `kwsEngine`; default `小智` wake sessions use it and switch to a fresh ASR session after detection.

- [ ] **Step 1: Add failing protocol tests** for valid/invalid `wakeWord` and literal parsed objects.
- [ ] **Step 2: Add failing server tests** proving: default wake gets `ready.strategy=kws`; no ASR receives PCM before detection; one keyword is emitted; later PCM reaches a newly created ASR session; custom wake and missing KWS use `strategy=asr`; finish before detection still emits `finished`; `/health` includes `kws`.
- [ ] **Step 3: Verify RED** with protocol/server focused tests.
- [ ] **Step 4: Implement a single per-socket strategy state machine**. On KWS hit, close KWS, emit keyword, create ASR; on reset reset the active stream; on stop close whichever streams exist; on finish flush ASR only and always emit `finished`.
- [ ] **Step 5: Wire KWS readiness and errors through `main.ts` without exposing paths**.
- [ ] **Step 6: Verify GREEN** for all voice-service tests and no open handles.

### Task 4: Desktop Keyword Routing and Wake-to-Command Transition

**Files:**
- Modify: `packages/desktop/main/voice-service-client.ts`
- Modify: `packages/desktop/main/voice-service-client.test.ts`
- Modify: `packages/desktop/main/voice-capture-state.ts`
- Modify: `packages/desktop/main/voice-capture-state.test.ts`
- Modify: `packages/desktop/main/index.ts`

**Interfaces:**
- `VoiceServiceClient.startAsr()` accepts `wakeWord?: string` and receives keyword events.
- `routeVoiceServiceResult()` accepts current-generation keyword events without applying utterance deduplication.
- A current keyword event restores the window, emits `wake:trigger`, and calls `startCapture("", true)`; later ASR partial/final text supplies the command.

- [ ] **Step 1: Add failing client fixture tests** for start `wakeWord`, `ready.strategy`, current keyword forwarding, and stale keyword rejection after a generation change.
- [ ] **Step 2: Add failing pure-state tests** showing keyword acceptance is generation-safe and does not change `lastFinalUtteranceId`.
- [ ] **Step 3: Verify RED** for client/state tests.
- [ ] **Step 4: Implement the client and pure routing changes**, retaining compatibility when old/fallback servers omit `strategy`.
- [ ] **Step 5: Integrate keyword handling in `index.ts`** before transcript matching. Only current hidden-window keyword events trigger wake; visible conversation behavior remains unchanged. Pass the configured wake word in start controls.
- [ ] **Step 6: After command finalization, restart a fresh wake generation** so the socket returns to KWS rather than leaving Zipformer permanently active.
- [ ] **Step 7: Verify GREEN** for focused desktop tests and `bun run compile`.

### Task 5: Explicit KWS Model Installation

**Files:**
- Create: `packages/voice-service/scripts/download-kws-model.sh`
- Modify: `packages/voice-service/README.md`
- Modify: `.gitignore` only if the existing `.agent-data` rule does not already cover KWS.

**Interfaces:**
- Script installs the pinned archive into `packages/desktop/.agent-data/kws-models/<model>` and creates the encoded `keywords.txt` for `小智`.
- Environment override: `VOICE_KWS_MODEL_DIR`.

- [ ] **Step 1: Determine and record the authoritative archive SHA-256** by downloading the official release archive once; fail installation when the checksum differs.
- [ ] **Step 2: Implement an idempotent shell installer** using a temporary directory, explicit archive target, checksum verification, extraction, and atomic move. Never overwrite an incomplete existing directory silently.
- [ ] **Step 3: Generate or validate `keywords.txt`** using the model's partial-pinyin tokens for `小智`, including `@小智`; run an actual `KeywordSpotter` construction to prove the file is accepted.
- [ ] **Step 4: Document local/remote KWS configuration, health semantics, fallback, model licensing caveat, and explicit install command.
- [ ] **Step 5: Run `bash -n` and `git diff --check`**.

### Task 6: Automated and Real Runtime Validation

**Files:**
- Modify only implementation/tests/docs required by failures found during validation.

**Interfaces:**
- Produces current evidence for model behavior, desktop behavior, and regression safety.

- [ ] **Step 1: Run all focused voice tests**: `PATH=/Users/caoqu/.bun/bin:$PATH bunx vitest run packages/voice-service/src packages/desktop/main/voice-capture-state.test.ts packages/desktop/main/voice-service-client.test.ts packages/desktop/main/voice-service-manager.test.ts packages/desktop/native/wakelistener-contract.test.ts`.
- [ ] **Step 2: Run builds**: `PATH=/Users/caoqu/.bun/bin:$PATH bun run --cwd packages/voice-service build` and `PATH=/Users/caoqu/.bun/bin:$PATH bun run --cwd packages/desktop compile`.
- [ ] **Step 3: Validate official KWS test WAVs** through the real Node addon, asserting at least the expected official keyword detections.
- [ ] **Step 4: Start the desktop via LaunchServices**, verify `/health` returns `ready/asr/kws/tts=true`, and verify the helper is `external-wake`.
- [ ] **Step 5: Perform hidden-window positive validation**: physical or deterministic microphone-path `小智` produces a keyword event, shows the window, accepts one following command, and sends it once.
- [ ] **Step 6: Perform bounded negative validation** during ordinary speech and confirm no keyword event/window wake in the observed interval.
- [ ] **Step 7: Recheck dictation, AI TTS, and barge-in/second-turn regressions, then run `git diff --check` and inspect the exact staged boundary.

### Task 7: Knowledge Capture, Commit, and Push

**Files:**
- Update Wiki through `$wiki-capture`; do not modify project `docs/` beyond the approved design/plan and README.
- Commit only KWS implementation, tests, scripts, design, plan, and README.

**Interfaces:**
- Produces a pushed feature branch and current Wiki/QMD record.

- [ ] **Step 1: Capture root cause, KWS architecture, model/token gotchas, and validation evidence in the Customer Agent voice Wiki page; refresh and verify QMD.
- [ ] **Step 2: Stage only intended files**, verify no `.next`, `.agents`, ASR POC, models, archives, WAVs, or temporary files are staged.
- [ ] **Step 3: Commit without `git-ai`**, using a focused `fix(voice): use dedicated KWS for wake word` message.
- [ ] **Step 4: Push the current feature branch and verify local/remote HEAD equality.
