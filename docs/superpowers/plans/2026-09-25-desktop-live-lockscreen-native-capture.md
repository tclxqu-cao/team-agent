# Desktop Live CLI Reuse Implementation Plan

> **For the main agent:** Implement directly in the current session. Do not
> dispatch implementation or review subagents. Preserve unrelated worktree
> changes and do not commit generated binaries or runtime data.

**Goal:** Use the existing CLI ScreenCaptureKit remote desktop from Desktop so
an already locked Mac can be awakened, viewed, and remotely unlocked without
keeping the display awake while nobody is watching.

**Architecture:** `cli-desktop:primary` remains the sole user-facing desktop
producer. Electron exposes its existing Desktop settings API as a proxy to the
selected shared service's `/api/remote-authorization` endpoint. The CLI owns
capture, WebRTC, input, display choice, and viewer-driven power lifecycle.

**Tech Stack:** Electron 44, TypeScript, Bun, Vitest, Node 22, Swift 5,
ScreenCaptureKit, VideoToolbox.

## Constraints

- Keep the CLI's existing viewer-count and three-second idle teardown contract.
- Do not publish `desktop:primary` from Electron.
- Do not add a second native capture helper or TCC identity.
- Keep Desktop Computer Use behavior separate and unchanged.
- Do not commit helper binaries, Desktop runtime data, or packaging output.

## Task 1: Add The Desktop CLI Proxy

**Files:**
- Create: `packages/desktop/main/desktop-live-cli-proxy.ts`
- Create: `packages/desktop/main/desktop-live-cli-proxy.test.ts`
- Modify: `packages/desktop/main/index.ts`

- [x] Map CLI authorization status to the existing `DesktopLiveStatus` shape.
- [x] Forward enable, disable, authorize, recheck, and restart actions.
- [x] Poll status without starting native capture and emit only changed state.
- [x] Feed CLI ownership into the existing local control banner and Computer
  Use ownership guard.

## Task 2: Make CLI Status Complete

**Files:**
- Modify: `packages/server/lib/remote-control/remote-authorization.mjs`
- Modify: `packages/server/lib/remote-control/remote-authorization.test.ts`
- Modify: `packages/server/native/remote-helper/main.swift`

- [x] Return authoritative `viewerCount` and `controlState` from CLI status.
- [x] Update control state from live-view registry events and clear it on
  disable/close.
- [x] Include macOS lock state in the native helper bridge status.
- [x] Extend server tests for takeover and return status transitions.

## Task 3: Remove The Duplicate Desktop Producer

**Files:**
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/renderer/components/DesktopLiveSettings.tsx`
- Restore: `packages/desktop/scripts/build-desktop-input.sh`
- Remove uncommitted standalone helper draft files.

- [x] Stop creating `DesktopScreenLive`, Electron `WebrtcLive`, and the
  Desktop-owned display assertion from the composition root.
- [x] Keep Desktop onboarding state only as a local UI marker; CLI state is the
  source of truth for whether sharing is enabled.
- [x] Remove Desktop settings display selection because the WebApp viewer
  already uses the CLI session's display metadata.
- [x] Preserve the Electron capture/input adapters used by Computer Use.

## Task 4: Verify And Deliver

- [x] Run focused Desktop proxy and CLI remote authorization tests.
- [x] Compile the CLI Swift helper and run its self-tests.
- [x] Compile Desktop and build Server with Node 22.
- [x] Run `git diff --check` and stage source/tests/docs only.
- [x] Commit and push with ordinary Git per project `CLAUDE.md`.
- [ ] Release the WebApp/Server to `:3000`, restart the repository-owned Desktop
  job, and record stable Build ID, PID, routes, session identity, WebRTC media,
  locked capture, unlock, and final-viewer teardown evidence.

Runtime progress: `:3000` Build ID `UQ6i1FofkgKOXhFivyFG2`, PID `9290`, core
routes, `cli-desktop:primary`, viewer-driven `caffeinate -u/-d`, physical
display sleep-to-wake, and final-viewer assertion release are verified. Locked
capture, WebRTC media, and password input remain open because the launched
helper currently reports `screen=false` and `accessibility=false` until macOS
permissions are granted to its app identity.
