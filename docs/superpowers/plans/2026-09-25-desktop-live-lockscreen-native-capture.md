# Desktop Live Lockscreen Native Capture Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Desktop live source wake and capture an already locked Mac, then return automatically to the existing Electron WebRTC stream after unlock.

**Architecture:** Gate all Desktop capture work on the relay's viewer count. Route locked or Electron-unavailable frames through a dedicated ScreenCaptureKit child helper, release that helper when viewing stops, and restart the existing WebRTC producer when capture returns to Electron.

**Tech Stack:** Swift 5, ScreenCaptureKit, CoreImage, Electron 44, TypeScript, Bun, Vitest, Node 22.

## Global Constraints

- Preserve the existing `desktop:primary` protocol and WebApp UI.
- Preserve unlocked Electron WebRTC as the normal high-frame-rate path.
- Start no capture backend and hold no display assertion while `viewerCount` is zero.
- Stop the native stream before releasing the final viewer's display assertion.
- Do not depend on or modify an installed CLI runtime.
- Do not commit generated helper binaries, Desktop runtime data, or packaging output.

---

### Task 1: Add the native lock-screen capture helper

**Files:**
- Create: `packages/desktop/native/desktop-capture.swift`
- Modify: `packages/desktop/scripts/build-desktop-input.sh`
- Create: `packages/desktop/main/desktop-capture-gateway.ts`
- Unit tests: `packages/desktop/main/desktop-capture-gateway.test.ts`

**Interfaces:**
- Consumes: JSON-lines requests `{ id, op: "capture", displayId, width, height, quality, maxBytes }` and `{ id, op: "stop" }`.
- Produces: `DesktopCaptureGateway.capture(request): Promise<DesktopNativeCapturedFrame>` and `stop(): Promise<void>`.

- [ ] **Step 1: Implement the ScreenCaptureKit stream**

Create a helper that selects the requested `SCDisplay`, starts one bounded
`SCStream`, stores the latest complete frame, and responds to pending capture
requests with base64 JPEG plus pixel and logical dimensions.

- [ ] **Step 2: Implement stop and error semantics**

`stop` must invalidate the stream epoch, fail pending requests, stop capture,
and return an idempotent success response. EOF must terminate the process.

- [ ] **Step 3: Build both Desktop helpers**

Extend `build-desktop-input.sh` to compile `desktop-input` and
`desktop-capture` into the already ignored `assets/bin` directory.

- [ ] **Step 4: Add the TypeScript gateway and tests**

Follow `DesktopInputGateway` JSON-lines conventions. Test request correlation,
base64 decoding metadata, helper exit rejection, timeout, and idempotent stop.

### Task 2: Route locked capture through the native helper

**Files:**
- Create: `packages/desktop/main/desktop-capture-router.ts`
- Unit tests: `packages/desktop/main/desktop-capture-router.test.ts`
- Modify: `packages/desktop/main/desktop-screen-screencast.ts`
- Modify: `packages/desktop/main/desktop-screen-screencast.test.ts`

**Interfaces:**
- Consumes: `isLocked(): boolean`, the existing Electron frame capture function, and `DesktopCaptureGateway`.
- Produces: `DesktopCaptureRouter.capture(options): Promise<DesktopCapturedFrame | null>` and `stop(): Promise<void>`.

- [ ] **Step 1: Implement backend selection**

Use native capture immediately when locked. Use Electron when unlocked, with
native fallback only when Electron returns no frame or throws.

- [ ] **Step 2: Implement unlock and stop transitions**

Stop a native stream before the first unlocked Electron frame. Fire one
`onElectronResume` callback for that transition and make `stop()` idempotent.

- [ ] **Step 3: Gate the screencast by viewer presence**

Add `setViewerActive(active)` to suspend the capture loop without ending the
published producer. Reset first-frame timeout for each new viewing interval and
release the router in the loop's inactive and terminal paths.

- [ ] **Step 4: Add routing and lifecycle tests**

Cover locked native selection, unlocked Electron selection, source-unavailable
fallback, one-time resume callback, no capture before a viewer, and release
after the final viewer.

### Task 3: Wire viewer lifecycle and WebRTC recovery

**Files:**
- Modify: `packages/desktop/main/desktop-screen-live.ts`
- Modify: `packages/desktop/main/desktop-screen-live.test.ts`
- Modify: `packages/desktop/main/webrtc-live.ts`
- Modify: `packages/desktop/main/webrtc-live.test.ts`
- Modify: `packages/desktop/main/index.ts`

**Interfaces:**
- Consumes: authoritative `browser:state.session.viewerCount` and Electron `powerMonitor.getSystemIdleState(1)`.
- Produces: viewer-gated `DesktopScreenScreencast`, packaged/dev helper path resolution, and resumable `WebrtcLive.restart()`.

- [ ] **Step 1: Forward viewer transitions to the screencast**

On zero-to-positive, wake/hold the display before activating capture. On
positive-to-zero, deactivate capture before releasing the display assertion.

- [ ] **Step 2: Make WebRTC restartable after terminal capture failure**

Remember whether a viewer requested video. Allow `restart()` to recreate a
closed capture window only while that request remains active; clear the request
on stop.

- [ ] **Step 3: Compose the capture router in Electron main**

Resolve `desktop-capture` beside `desktop-input`, use powerMonitor for lock
state, inject the router as the screencast frame source, and restart WebRTC on
native-to-Electron transition.

- [ ] **Step 4: Extend coordinator and WebRTC tests**

Assert viewer transitions reach both power and capture lifecycles, and that a
failed closed WebRTC attempt can restart after unlock but not after viewer stop.

### Task 4: Build, runtime verification, delivery, and knowledge capture

**Files:**
- Verify: all Task 1-3 files
- Update: `projects/customer-agent/skills/desktop-live-lockscreen-remote-unlock.md` in the Obsidian wiki

**Interfaces:**
- Consumes: Desktop build scripts, the running `:3000` service, launchd Desktop dev job, and ordinary Git project policy.
- Produces: tested source commit, pushed branch, updated `:3000`, restarted Desktop app, and end-to-end runtime evidence.

- [ ] **Step 1: Build the native helpers and Desktop TypeScript**

Run `PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/desktop build:helper`
and `PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/desktop compile`.

- [ ] **Step 2: Run focused unit tests and diff checks**

Run the gateway, router, screencast, live coordinator, WebRTC, and display power
tests, followed by `git diff --check`.

- [ ] **Step 3: Restart runtime and verify the locked workflow**

Restart only the repository-owned Desktop launchd job, then verify lock-screen
capture, remote unlock, WebRTC recovery, final-viewer assertion release, and
native helper exit. Rebuild/restart `:3000` with the release skill and verify
Build ID, PID stability, and key routes.

- [ ] **Step 4: Commit and push source only**

Stage only source, tests, specs, and plan files. Exclude `assets/bin`, release
artifacts, `.agent-data`, `.superpowers`, and wiki query logs. Commit and push
with ordinary Git as required by the project-level `CLAUDE.md`.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run \
  packages/desktop/main/desktop-capture-gateway.test.ts \
  packages/desktop/main/desktop-capture-router.test.ts \
  packages/desktop/main/desktop-screen-screencast.test.ts \
  packages/desktop/main/desktop-screen-live.test.ts \
  packages/desktop/main/webrtc-live.test.ts \
  packages/desktop/main/display-keep-awake.test.ts
```

Expected: all tests pass. Fix implementation or tests and rerun until green.

