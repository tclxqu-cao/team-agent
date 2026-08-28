# Voice Barge-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 播报期间检测用户开口，立即停播并将完整语句作为同 session 下一轮输入，随后播报新回答。

**Architecture:** Swift helper 增加带 voice processing 的 `barge-in` 模式并输出 `BARGE_IN` 协议；Electron main 管理 TTS/helper/capture 状态；renderer 的显式输入入口调用 `ttsStop`。现有 `wake:command` 和 autoSpeak 继续承担会话发送与下一轮播报。

**Tech Stack:** Swift 5, Speech, AVFoundation, Electron IPC, React, TypeScript, Bun test

## Global Constraints

- 不引入新依赖。
- 自动语音抢话只在 voice conversation 的 TTS 中启用。
- 必须保留抢话语句开头，不得在检测后才新建录音。
- TTS 回声不得自动发送为用户消息。

---

### Task 1: Barge-In State Contract

**Files:**
- Modify: `packages/desktop/main/voice-capture-state.ts`
- Modify: `packages/desktop/main/voice-capture-state.test.ts`

**Interfaces:**
- Produces: `getTtsListeningMode(conversation: boolean): "barge-in" | "suspended"`
- Produces: `shouldAcceptBargeIn(ttsSpeaking: boolean, conversation: boolean): boolean`

- [x] Write failing tests asserting conversation TTS selects `barge-in`, manual TTS selects `suspended`, and only the former accepts `BARGE_IN`.
- [x] Run `bun test packages/desktop/main/voice-capture-state.test.ts` and confirm missing exports fail.
- [x] Implement the two pure functions with direct boolean conditions.
- [x] Re-run the test and confirm green.

### Task 2: Swift Barge-In Protocol

**Files:**
- Modify: `packages/desktop/native/wakelistener.swift`
- Rebuild: `packages/desktop/native/wakelistener`

**Interfaces:**
- Consumes helper mode argument `barge-in`.
- Produces stdout line `BARGE_IN` once per recorded segment before `TEXT/FINAL`.

- [x] Add a failing source contract test to `voice-capture-state.test.ts` that expects `parseWakeControlLine("BARGE_IN")` to return `"barge-in"`.
- [x] Implement the parser in `voice-capture-state.ts` and verify RED to GREEN.
- [x] In Swift, enable `input.setVoiceProcessingEnabled(true)` for `barge-in`, track sustained post-AEC speech, emit `BARGE_IN` once, and keep writing the same recording file.
- [x] Compile with `swiftc -swift-version 5 -O -framework Speech -framework AVFoundation packages/desktop/native/wakelistener.swift -o packages/desktop/native/wakelistener`.

### Task 3: Main-Process TTS and Capture Routing

**Files:**
- Modify: `packages/desktop/main/index.ts`

**Interfaces:**
- Consumes `getTtsListeningMode`, `shouldAcceptBargeIn`, and `parseWakeControlLine`.
- Produces immediate old-`say` termination and subsequent `wake:command` from the same helper segment.

- [x] Make `tts:speak` choose helper mode from conversation state instead of always stopping helper.
- [x] On accepted `BARGE_IN`, kill only the current `say`, clear grace state, set `ttsSpeaking=false`, and arm follow-up capture without restarting helper.
- [x] Route subsequent transcript through existing capture/final logic; ignore `BARGE_IN` outside conversation TTS.
- [x] Preserve the existing process identity guard so stale TTS exit events cannot alter the new state.

### Task 4: Explicit Input Interruption

**Files:**
- Create: `packages/desktop/renderer/lib/voice-interruption.ts`
- Create: `packages/desktop/renderer/lib/voice-interruption.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`

**Interfaces:**
- Produces: `interruptSpeech(api, stopWebSpeech): void`.

- [x] Write a failing test asserting both native `ttsStop` and browser `stopSpeaking` are invoked.
- [x] Implement the helper and verify green.
- [x] Call it before starting dictation and after validating a non-empty `handleSend` input.

### Task 5: Verification

**Files:**
- Verify all modified files and running desktop app.

- [x] Run `bun test packages/desktop/main packages/desktop/renderer` and expect all desktop tests pass.
- [x] Run `bun run --cwd packages/desktop compile` and Swift compile; expect exit 0.
- [x] Run `git diff --check`.
- [x] Restart Electron via LaunchServices and verify helper `READY`, `engine=true`, `barge-in` during TTS, `BARGE_IN` on near-end speech through the real audio pipeline, same-session next user message, and next assistant TTS.

Verification evidence: deterministic near-end speech traversed the helper's audio tap, VAD, CAF recording, `SFSpeechURLRecognitionRequest`, `BARGE_IN`, and `FINAL` protocol. The old `say` process stopped immediately, the complete transcript remained in the same session, and the next assistant response launched a new `say`. A separate production-device run kept voice processing enabled for 27 seconds of TTS without self-interruption. Typed send and input-box dictation also terminated their active `say` processes in renderer-driven runtime checks.
