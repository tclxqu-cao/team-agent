# Remote Desktop Latency Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix avoidable remote desktop connection and feedback latency, verify through http://100.121.10.115:3000/web, and restart the managed 3000 service.

**Architecture:** Validate the browser's negotiated video answer before waiting for ICE. Use actual playback progress to pause each viewer's redundant JPEG delivery while retaining its newest fallback frame. Reduce native JPEG sampling only when the sole viewer confirms healthy video; keep other viewers and fallback responsive.

**Tech Stack:** React, TypeScript, Node 22, werift, Vitest, existing macOS remote helper, Ego browser.

## Global Constraints

- Preserve unrelated dirty changes, existing selected screen, paired access, and installed helper identity.
- Do not update project docs or publish npm packages.
- Do not call network RTT or an RPC response an end-to-end latency result.
- Restart 3000 after building; inspect active native runs and preserve its launchd configuration.

### Task 1: Remove the rejected-codec wait

**Files:** `packages/server/lib/remote-control/infrastructure/werift-video-transport.mjs`, `packages/server/lib/remote-control/application/remote-video-session.mjs`, their existing tests.

- [x] Reproduce through 100 IP with a real browser answering High with `m=video 0`; baseline connection takes 22.5 seconds.
- [x] Parse answers with werift `SessionDescription.parse(sdp.sdp)`; require a receiving H264 video m-line whose port is nonzero. Throw `Viewer rejected H.264 video` otherwise.
- [x] Catch answer failure in `RemoteVideoSession.handle`, invoking the existing one-time codec fallback for the same transport/generation.
- [x] Cover rejected/inactive/send-only video, an audio-only answer, and immediate fallback without advancing the connection timeout.

### Task 2: Avoid parallel JPEG competition during actual video playback

**Files:** `packages/server/lib/browser-live/viewer-frame-flow.mjs`, new `viewer-video-flow.mjs`, `packages/server/ws-server.mjs`, `packages/desktop/renderer/components/BrowserLivePanel.tsx`, related tests.

- [x] Add `ViewerFrameFlow.setPaused(boolean)`. Offers retain only the newest fallback while paused; resuming immediately flushes it within the existing ACK/byte limits.
- [x] Relay validated viewer signals through the existing registry before changing delivery. `viewer-trace/playback-ready` pauses JPEG; `jpeg-fallback`, start, stop, return, unwatch, and failed transport restore it.
- [x] Emit playback-ready only after a positive advancing frame counter; restore fallback during media effect cleanup.
- [x] Verify authorization failure cannot pause delivery and a second viewer remains independent.

### Task 3: Reduce native fallback work without changing helper permissions

**Files:** `packages/server/lib/remote-control/remote-authorization.mjs`, `packages/server/lib/remote-control/application/remote-video-session.mjs`, existing tests.

- [x] Track healthy playback in the video session; clear it at fallback, pause and stop.
- [x] Keep the existing 2000ms native JPEG interval only for one viewer with connected, confirmed playing video; restore 67ms interaction/200ms idle preview for fallback and other viewers. The current connected-only guard incorrectly throttles both cases to 0.5 FPS.
- [x] Test the actual scheduler with fake timers, adding a second viewer and triggering fallback.

### Task 4: Deploy and repeat the same end-to-end checks

- [x] Native AppKit probe responds to real remote mouse-up; browser detects changed video pixels. Baseline 8 samples: 144–209ms; a compositor callback had an unrelated ~1s throttle and is excluded.
- [x] Build affected packages, preserve rollback artifacts, inspect active native sessions, restart launchd's existing 3000 job, and verify one listener and stable PID.
- [x] Repeat rejected-codec startup and pixel detection through the 100 IP. Exercise mobile-sized touch, video loss/JPEG fallback/recovery, and real WeCom navigation.
- [x] Record comparative measurements, delivery bytes/frames, final runtime state, and physical-device/network boundaries; close the probe and release test control.

### Follow-up: Remove remote-menu obstruction and surface input failures

**Files:** `packages/desktop/renderer/components/BrowserLivePanel.tsx`, `packages/server/app/web/ResponsiveToolbar.tsx`, `packages/server/app/web/compact-toolbar.test.tsx`.

- [x] Reproduce through the 100 IP: selecting remote desktop leaves the outer menu expanded; injected `{ input: { error } }` is silently ignored on mouse-up.
- [x] Route ordinary input and hit-test replies through one error-checking dispatcher; retain paste confirmation and existing input/control guards.
- [x] Close overflow only when selecting the remote-desktop action in compact, classic, and glass mobile toolbar variants.
- [x] Update the existing stale compact-layout test expectation to the already-present `navigationLayout !== "classic"` contract; preserve shell implementation.
- [x] Run affected checks, build staged WebApp/Next artifacts, inspect active native runs, restart managed 3000, and repeat the original 100-IP interaction checks.

## Final Unit Test Verification

- [x] Main agent: run affected tests after development is complete.

Run: `bunx vitest run packages/server/lib/browser-live/viewer-frame-flow.test.ts packages/server/lib/browser-live/viewer-video-flow.test.ts packages/server/lib/remote-control/infrastructure/werift-video-transport.test.ts packages/server/lib/remote-control/application/remote-video-session.test.ts packages/server/lib/remote-control/remote-authorization.test.ts packages/desktop/renderer/components/BrowserLivePanel.test.ts packages/desktop/renderer/components/remote-video-stats.test.ts`

Expected: PASS. Then build WebApp and Server and verify the deployed behavior through the requested address.

## Current evidence

- Seven targeted files: 99 tests passed; the playback reconfiguration follow-up passed 37 affected tests.
- Core, native-runtime, staged WebApp and staged Next build completed. Next Build ID: `MfF9Y-2pvTyniN2y6oTi8`.
- Baseline real decoded-pixel latency: median 172.95ms, range 144.2–209.3ms (8 samples). Rejected High signaling start to connected: 20431.6ms.
- Forced stalled-playback fallback produced JPEG gaps of 2055.5ms and 2038.0ms before repair.
- Deployment watcher: `/Users/caoqu/.codex/artifacts/agentroam-remote-latency-20261105-0030/apply_when_idle.py`. The ZCode run finished naturally; the watcher swapped prepared artifacts and restarted the existing launchd job. PID 25225 remains stable with one listener, the requested 100 IP URL works, and installed helper fingerprint 334100e5afbc is unchanged.
- Deployed rejected-High startup: connected 442.4ms, first real decoded frame 462.7ms. Normal startup: connected 461.4ms, first decoded frame 477.8ms.
- Deployed normal click pixels: 8 valid samples, median 165.3ms, range 112.7–312.5ms. This is little change from the baseline, not a broad normal-latency improvement.
- Forced JPEG fallback: 25 frames / 3,274,297 bytes, median interval 270.3ms. Four fallback clicks: median 212.65ms. Mobile 390×844 touch: 4/4 valid changes, median 165.35ms.
- HD→smooth→HD produced actual widths 2560→1280→2560; zero redundant JPEG frames in the 3.59-second healthy observation. Real WeCom document navigation and mobile-touch assistant navigation verified in native windows and the remote stream.
- Test control ended, browser TaskSpace finished, viewerCount=0, and Probe process absent. Remote sharing remains enabled with screen/accessibility=true. Evidence: `verification.md`, `verification.json`, `final-runtime.json`, and `verified-probe/` in the artifact directory.
- Acceptance boundary: same-Mac browser via the 100 IP plus mobile touch emulation; physical iPhone Wi-Fi/5G end-to-end acceptance was not performed.
- Follow-up: actual iOS 26.5 Safari in an Apple iPhone 11 Simulator passed native probe touch/color feedback and two messages→documents→assistant navigation sequences. HD→smooth→HD decoded widths were 2560→1280→2560; 241 receiver samples had median 13 FPS, no reported loss or decode drops. This strengthens the iOS software acceptance boundary but does not replace a physical iPhone network sample.
- Latest observed runtime after an intervening restart: PID96146, same Build ID `B8pyjPR4qzM2O68yBAmII` and unchanged WebApp SHA256. Test control ended, viewerCount=0, simulator returned to Shutdown, temporary Safari developer display setting restored. Evidence: `safari-ios-20261105/` under the artifact directory.
- Input-feedback follow-up: 106 tests in 8 files passed; WebApp/Next build and scoped diff checks passed. After another native task completed naturally, managed 3000 restarted96146→41290 with Build ID `sJ9qC-JEX1o-gtJhnpkXb`. The mobile menu no longer intercepts input, four injected failure shapes show feedback, and actual iOS26.5 Safari repeated WeCom document/assistant navigation through the 100 IP. Final41290 single listener, viewerCount=0, agent-controlled, simulatorShutdown, helper unchanged. Evidence: `input-feedback-20261105/verification.md` and JSON; no physical-phone network or new iOS timing sample.
