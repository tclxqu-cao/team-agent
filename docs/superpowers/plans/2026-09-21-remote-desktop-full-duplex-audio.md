# Remote Desktop Full-Duplex Audio Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit foreground-only, controller-owned full-duplex audio to WebApp remote desktop sessions on macOS and Windows.

**Architecture:** Extend the live-view domain with transport-independent audio capabilities and state, then carry bounded audio control and PCM messages over the existing authenticated media-signaling channel. Native helpers capture system audio and play microphone PCM while excluding their own process audio; the shared BrowserLivePanel owns permission, playback, mute, visibility, and cleanup behavior.

**Tech Stack:** TypeScript, React, browser mediaDevices/Web Audio, authenticated WebSocket signaling, ScreenCaptureKit/AVAudioEngine, WASAPI/waveOut, Vitest.

## Global Constraints

- Audio starts only after an explicit **Start voice** user action.
- Only the active remote controller may publish microphone audio.
- The WebApp must be foreground-visible; backgrounding stops voice and never auto-resumes it.
- macOS and Windows expose the same domain and UI contract.
- Existing video, JPEG fallback, input control, quality selection, and unrelated dirty worktree changes must remain intact.
- Audio data is transient and never persisted.

---

### Task 1: Remote Audio Domain

**Files:**
- Create: `packages/core/src/domain/live-view/remote-audio.ts`
- Create: `packages/core/src/domain/live-view/remote-audio.test.ts`
- Modify: `packages/core/src/domain/live-view/index.ts`

**Interfaces:**
- Produces: `RemoteAudioCapabilities`, `RemoteAudioState`, `RemoteAudioSnapshot`, `RemoteAudioSession.dispatch(action)`.

- [x] **Step 1: Add immutable capability and state types**

Define full-duplex, system-audio, microphone-playback, and self-playback-exclusion capability flags plus `idle | starting | live | failed` state.

- [x] **Step 2: Implement the state machine**

Accept start, connected, stop, failure, microphone mute, speaker mute, foreground, and controller actions. Start succeeds only when controller, foreground, and full-duplex capabilities are true; losing either controller or foreground returns to idle.

- [x] **Step 3: Add focused domain tests**

Cover allowed start, rejected viewer start, foreground suspension, controller loss, independent mute, failure, and repeated stop.

### Task 2: Session Metadata And Signal Boundary

**Files:**
- Modify: `packages/core/src/domain/live-view/entities.ts`
- Modify: `packages/core/src/domain/live-view/live-view-registry.ts`
- Modify: `packages/core/src/domain/live-view/live-view-registry.test.ts`
- Modify: `packages/server/lib/remote-control/remote-video-signal.mjs`
- Modify: `packages/server/lib/remote-control/remote-video-signal.test.ts`

**Interfaces:**
- Consumes: `RemoteAudioCapabilities`.
- Produces: `LiveViewSessionView.audioCapabilities` and bounded audio control/state/PCM signals.

- [x] **Step 1: Validate and project audio capabilities**

Normalize the four boolean capability flags when a producer publishes a session; omit invalid or absent capabilities.

- [x] **Step 2: Extend bounded signaling**

Allow viewer `audio-start`/`audio-stop`/`audio-microphone` and producer `audio-state`/`audio-system`; bound PCM, state, and error text at the server boundary.

- [x] **Step 3: Verify ownership and compatibility**

Add tests proving audio start is controller-only while sessions without capabilities remain unchanged.

### Task 3: Native Producer Full-Duplex Audio

**Files:**
- Modify: `packages/server/lib/remote-control/remote-authorization.mjs`
- Modify: `packages/server/lib/remote-control/helper-manager.mjs`
- Modify: `packages/server/lib/remote-control/windows-helper.mjs`
- Create: `packages/server/native/remote-helper/service/Audio.swift`
- Create: `packages/server/native/remote-helper-windows/audio.cpp`
- Modify: native helper entry points and build scripts

**Interfaces:**
- Consumes: `audio-start`, `audio-stop`, and bounded microphone PCM.
- Produces: bounded system PCM, local microphone playback, and `audio-state` while preserving the video peer.

- [x] **Step 1: Publish desktop audio capability**

Native CLI desktop sessions advertise full-duplex audio, system-audio capture, microphone playback, and self-playback exclusion on macOS and Windows builds that provide self-excluding process loopback (Windows build 20348+).

- [x] **Step 2: Enable loopback only for explicit audio capture**

Keep initial desktop capture audio-off; start ScreenCaptureKit or WASAPI loopback only when the controller explicitly requests voice.

- [x] **Step 3: Add producer audio lifecycle**

On `audio-start`, start self-excluding system capture and accept viewer microphone PCM. On `audio-stop`, stop capture and local playback while preserving video.

- [x] **Step 4: Add producer contract tests**

Assert explicit activation, loopback request, incoming audio playback, audio-state reporting, and audio-only teardown.

### Task 4: WebApp Full-Duplex Controls

**Files:**
- Modify: `packages/desktop/renderer/components/BrowserLivePanel.tsx`
- Modify: `packages/desktop/renderer/components/BrowserLivePanel.test.ts`
- Modify: `packages/webapp/src/presentation/web.css`

**Interfaces:**
- Consumes: `LiveViewSessionView.audioCapabilities`, `audio-state`, and audio-bearing offers.
- Produces: explicit audio start/stop, microphone sender, system-audio playback, independent mute controls, and foreground cleanup.

- [x] **Step 1: Add viewer audio state and media ownership**

Track microphone stream, microphone sender, remote audio element, start state, errors, and mute state in refs/state without storing media data.

- [x] **Step 2: Implement explicit start and stop**

Request `getUserMedia` with echo cancellation, noise suppression, and automatic gain control. Send `audio-start` only after permission succeeds. Stop every local track and send `audio-stop` on user action, session change, control loss, panel close, unmount, or hidden visibility.

- [x] **Step 3: Route bounded PCM in both directions**

Keep video on its existing WebRTC peer, encode microphone chunks after the explicit gesture, and schedule system PCM through a foreground Web Audio context.

- [x] **Step 4: Add accessible controls**

Show Start voice only for a capable desktop session controlled by this viewer. During a live call show microphone mute, speaker mute, and end-call icon buttons with tooltips and stable dimensions.

- [x] **Step 5: Add focused UI tests**

Verify source contracts for media constraints, capability gating, signal names, visibility cleanup, track routing, and accessible labels.

### Task 5: Integration And Regression Checks

**Files:**
- Modify only files required to fix failures found by the commands below.

**Interfaces:**
- Consumes: completed domain, signaling, producer, and viewer changes.
- Produces: a buildable full-duplex implementation with existing remote video behavior preserved.

- [x] **Step 1: Run focused tests**

Run the new domain, registry, signal, Electron producer, DesktopScreenLive, and BrowserLivePanel tests.

- [x] **Step 2: Run package builds**

Build core, server, desktop, and WebApp; fix type or bundling failures within feature scope.

- [x] **Step 3: Run local browser acceptance where available**

Verify the remote desktop UI renders the explicit voice controls and that backgrounding executes audio cleanup. Record macOS/Windows real-audio verification limits separately from automated evidence.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/core/src/domain/live-view/remote-audio.test.ts packages/core/src/domain/live-view/live-view-registry.test.ts packages/server/lib/remote-control/remote-video-signal.test.ts packages/desktop/main/webrtc-live.test.ts packages/desktop/main/desktop-screen-live.test.ts packages/desktop/renderer/components/BrowserLivePanel.test.ts`

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
