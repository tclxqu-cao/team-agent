# Desktop Live Lockscreen Native Capture Design

- Date: 2026-09-25
- Status: approved
- Baseline: `0f57620`
- Related: `2026-09-25-desktop-live-viewer-driven-display-wake-design.md`

## Problem

The Desktop live source wakes and holds the Mac display only while a WebApp
viewer is present. That power lifecycle works, but an already locked Mac still
cannot be watched: Electron `desktopCapturer.getSources()` returns no displays
while LoginWindow owns the screen.

The failure is specific to the capture backend. On the same locked and awakened
Mac, an Electron probe returned zero sources for 15 seconds while the existing
CLI ScreenCaptureKit helper captured a 2560x1440 lock-screen frame immediately.
Repeating `caffeinate -u` or retrying Electron therefore cannot repair this path.

## Goals

- A WebApp viewer opening `desktop:primary` wakes an already locked Mac and
  receives its lock-screen image.
- Remote pointer and keyboard input continue through the existing
  `desktop-input` gateway so the viewer can enter a password at LoginWindow.
- After unlock, the source automatically returns to the existing Electron
  WebRTC path instead of remaining on JPEG fallback.
- No viewer means no display assertion, no ScreenCaptureKit stream, and no
  Electron screenshot loop.
- Existing unlocked capture, multi-display selection, input, and CLI behavior
  remain unchanged.

## Architecture

### Viewer-gated capture

`DesktopScreenLive` already receives the authoritative relay `viewerCount`.
It will forward the zero/non-zero transition to `DesktopScreenScreencast` in
addition to controlling `DisplayKeepAwake`.

`DesktopScreenScreencast.start()` remains the producer's long-lived operation,
but it waits without capturing while no viewer is present. The first viewer
starts a fresh first-frame deadline. The last viewer stops the active capture
backend before the display assertion is released.

### Native lock-screen helper

A dedicated `desktop-capture` Swift helper will use ScreenCaptureKit and a
JSON-lines stdin/stdout protocol. It accepts bounded capture requests for a
display, maintains one `SCStream` while that viewer session is active, and
returns JPEG bytes plus logical display coordinates. `stop` tears down the
stream and clears pending requests.

The helper is a child of the Desktop app and is built beside the existing
`desktop-input` helper. It is not the separately installed CLI helper and does
not add a dependency on the CLI package or its runtime files.

### Capture routing

`DesktopCaptureRouter` keeps the backend choice outside the screencast loop:

1. When Electron reports the session as locked, capture directly through the
   native helper without first waiting for `desktopCapturer` to time out.
2. When unlocked, use the existing Electron capture function.
3. If Electron unexpectedly yields no source, use the native helper as a
   bounded fallback for that viewer session.
4. When a native-backed session becomes unlocked, stop its `SCStream`, switch
   back to Electron, and request WebRTC renegotiation.
5. When the last viewer leaves, stop the helper regardless of current backend.

The normal unlocked WebRTC pipeline remains authoritative. Native capture is a
lock-screen and source-unavailable JPEG bridge, not a replacement video stack.

## Data Flow

```text
WebApp watches desktop:primary
  -> viewerCount 0 -> 1
  -> wake display + acquire display-sleep assertion
  -> DesktopScreenScreencast becomes active
  -> locked? yes
  -> DesktopCaptureRouter -> desktop-capture (ScreenCaptureKit)
  -> JPEG lock-screen frames -> WebApp
  -> existing desktop-input helper injects password keys
  -> locked? no
  -> stop native SCStream
  -> Electron capture resumes
  -> WebrtcLive restarts negotiation

WebApp closes the panel
  -> viewerCount 1 -> 0
  -> screencast releases active backend
  -> release display-sleep assertion
```

## Failure Handling

- Native helper startup, malformed responses, permission denial, and capture
  timeouts surface through the existing live-view unavailable path.
- A missing first frame is timed only while a viewer is active. Idle publication
  can remain discoverable indefinitely without producing frames.
- Backend teardown is idempotent and runs after viewer loss, producer failure,
  feature disable, and app quit.
- A lock-state race may cause one Electron attempt to return no source; the
  router then falls back to native capture without closing the live session.
- FileVault pre-boot remains unsupported because neither ScreenCaptureKit nor
  CGEvent runs before LoginWindow.

## Verification

- Unit tests cover viewer gating, backend selection, native teardown, unlock
  transition, helper protocol errors, and WebRTC restart after a closed failed
  attempt.
- The Swift helper must compile with the repository's existing macOS toolchain.
- Desktop TypeScript compile and focused Vitest suites must pass.
- End-to-end acceptance is: start Desktop unlocked, let macOS lock, open the
  Desktop live source in WebApp, observe a lock-screen frame, take control,
  enter the password, observe the unlocked desktop, and confirm WebRTC resumes.
- After closing the final viewer, `pmset -g assertions` must show no
  AgentRoam-owned `NoDisplaySleepAssertion`, and the native helper must not
  remain running.

