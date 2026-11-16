# Remote Desktop QoS and Mac Shortcuts Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Stop stable high RTT from collapsing remote desktop FPS and make common shortcuts use the controlled desktop's modifier key.

**Architecture:** Keep the existing domain policy and its loss, bandwidth, encoder pressure and recovery logic; remove absolute RTT as an independent pressure signal. Resolve shortcut modifiers from the session's existing backend/platform metadata and make the Electron desktop producer publish its platform.

**Tech Stack:** TypeScript, React, Node/Electron, Vitest.

## Global Constraints

- User approved the two confirmed fixes after the preceding diagnosis. Use the lightweight bug-fix workflow.
- Preserve parallel ChatView, composer.css and Qoder changes; edit only the seven affected source/test files.
- Project docs/code-standards.md is absent; follow CLAUDE.md interface and architecture boundaries.
- No project docs changes, commit/push, shared dist rebuild or service restart in this source-fix task.
- Existing real loss, encoder pressure, conservative recovery and unknown-platform shortcut behavior remain covered.

### Task 1: Correct network pressure evidence

**Files:** `packages/core/src/domain/live-view/remote-video-policy.ts`, `remote-video-policy.test.ts`, `packages/server/lib/remote-control/application/remote-video-session.test.ts`.

**Interfaces:** Consumes existing `RemoteVideoObservation`; produces the unchanged `RemoteVideoDecision`.

- [x] Remove absolute RTT thresholds from severe and ordinary pressure. Keep the existing relative baseline check inside corroborated throughput pressure:

```ts
const severeNetwork = lossRate >= 0.12 || droppedFrames >= 8;
const networkPressure = severeNetwork || lossRate >= 0.05 || droppedFrames > 0 || throughputPressure;
```

- [x] Cover 280/600ms stable RTT with both ample and sparse-stream bandwidth estimates, a healthy path RTT change, real loss protection and recovery at high RTT. Existing queue growth and encoder tests remain required.
- [x] Make the native media session tests consume the current source policy, and exercise receiver stats through its real sampling loop at 280/600ms so a stale core dist cannot conceal a regression.

### Task 2: Resolve shortcuts from the controlled platform

**Files:** `packages/desktop/renderer/components/BrowserLivePanel.tsx`, `BrowserLivePanel.test.ts`, `packages/desktop/main/desktop-screen-live.ts`, `desktop-screen-live.test.ts`.

**Interfaces:** Consumes existing session `backend` and `platform`; produces `"Meta" | "Control"` through `remoteShortcutModifier`.

- [x] Add and use the platform resolver in the common shortcut callback:

```ts
return session?.backend === "desktop" && session.platform === "darwin" ? "Meta" : "Control";
```

- [x] Cover controlled Mac, Windows, Linux, unknown platform and browser sessions. Select by producer OS rather than viewing device OS.
- [x] Include `platform: process.platform` in Electron desktop metadata, and extend the existing publication test to assert it. CLI publication already carries platform.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run `bunx vitest run packages/core/src/domain/live-view/remote-video-policy.test.ts packages/core/src/domain/live-view/live-view-registry.test.ts packages/core/src/infrastructure/live-view/producer.test.ts packages/desktop/renderer/components/BrowserLivePanel.test.ts packages/desktop/main/desktop-screen-live.test.ts packages/desktop/main/webrtc-live.test.ts packages/server/lib/remote-control/application/remote-video-session.test.ts packages/server/lib/remote-control/webrtc-video.test.ts`.

Expected: PASS. Run the WebApp typecheck, replay the diagnosed RTT/loss cases, and review the seven-file diff against the approved scope. Capture the fix and its activation/real-device verification boundaries in wiki.
