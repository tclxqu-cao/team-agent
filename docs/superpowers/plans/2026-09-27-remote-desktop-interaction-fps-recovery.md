# Remote Desktop Interaction FPS Recovery Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore responsive remote-desktop video immediately after user input, keep idle video at 15 FPS, and persist sanitized adaptive-media diagnostics.

**Architecture:** `RemoteVideoPolicy` owns the interaction transition and idle floor. `RemoteVideoSession` applies interaction decisions through its existing coalesced tuning chain and emits deduplicated telemetry through an injected logger; `RemoteAuthorization` signals accepted input without waiting for encoder tuning.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, ScreenCaptureKit/VideoToolbox helper protocol, existing `installGlobalLogging` NDJSON logger.

## Global Constraints

- Preserve the current `ScreenCaptureKit -> VideoToolbox -> binary IPC -> werift` transport.
- Remote input must not wait for encoder tuning.
- Encoder and network pressure may still cap FPS below the interaction target.
- Logs must exclude input text, SDP, ICE addresses, TURN credentials, pixels, and authentication data.
- Do not modify unrelated dirty worktree files.

---

### Task 1: Media Policy Interaction Transition

**Files:**
- Modify: `packages/core/src/domain/live-view/remote-video-policy.ts`
- Unit tests: `packages/core/src/domain/live-view/remote-video-policy.test.ts`

**Interfaces:**
- Consumes: existing `RemoteVideoDecision` and pressure state.
- Produces: `RemoteVideoPolicy.noteInteraction(): RemoteVideoDecision`.

- [x] **Step 1: Change the idle activity floor**

Set a confirmed idle desktop to 15 FPS instead of 5 FPS while preserving the three-second demotion delay.

- [x] **Step 2: Add the interaction transition**

Add `noteInteraction()` that clears idle timing, sets activity FPS to 30, resets motion sample state, and returns `current("interaction")`. Do not reset `pressureFps` or bitrate.

- [x] **Step 3: Update focused policy tests**

Assert delayed idle demotion reaches 15 FPS, interaction immediately requests 30 FPS in a healthy session, and existing encoder pressure still limits the effective result.

### Task 2: Session Wake And Sanitized Telemetry

**Files:**
- Modify: `packages/server/lib/remote-control/application/remote-video-session.mjs`
- Unit tests: `packages/server/lib/remote-control/application/remote-video-session.test.ts`

**Interfaces:**
- Consumes: `RemoteVideoPolicy.noteInteraction()` and optional logger `{ info(message, data) }`.
- Produces: `RemoteVideoSession.noteInteraction(): RemoteVideoDecision`.

- [x] **Step 1: Inject an optional media logger**

Accept `logger` in the constructor and default it to `null`. Store only sanitized normalized media fields.

- [x] **Step 2: Implement non-blocking interaction tuning**

Call `policy.noteInteraction()`, enqueue it through `applyTuning()`, emit a deduplicated `remote video decision` record, and return immediately without awaiting `tuningChain`.

- [x] **Step 3: Log adaptive samples on material changes**

After each two-second snapshot, log the decision plus content activity/confidence, network RTT/loss/available bitrate/drops, and encoder pending/latency/drops/sequence. Deduplicate using a stable JSON key of the normalized payload.

- [x] **Step 4: Add focused session tests**

Assert interaction returns before a pending encoder apply resolves, repeated interaction decisions do not flood logs, changed telemetry logs once, and records contain no signaling or input payload fields.

### Task 3: Input Wiring And Composition Root

**Files:**
- Modify: `packages/server/lib/remote-control/remote-authorization.mjs`
- Modify: `packages/server/lib/remote-control/webrtc-video.mjs`
- Modify: `packages/server/ws-server.mjs`
- Unit tests: `packages/server/lib/remote-control/remote-authorization.test.ts`

**Interfaces:**
- Consumes: `RemoteWebrtcVideo.noteInteraction()` inherited from `RemoteVideoSession` and injected `globalLogger`.
- Produces: accepted remote input wakes media before helper dispatch.

- [x] **Step 1: Pass the logger through composition**

Add `logger` to `RemoteWebrtcVideo`, pass it to `RemoteVideoSession`, accept it in `RemoteAuthorization`, and inject `globalLogger` from `ws-server.mjs`.

- [x] **Step 2: Wake video on accepted input**

After generation, bounds, and accessibility checks pass, call `this.video.noteInteraction()` before `dispatch(event.input)`. Keep media tuning best effort and independent from input results.

- [x] **Step 3: Add authorization regression coverage**

Verify pointer, wheel, key, and text events trigger interaction wake while rejected input does not; preserve existing helper command and token result assertions.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/Users/caoqu/.bun/bin:/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run \
  packages/core/src/domain/live-view/remote-video-policy.test.ts \
  packages/server/lib/remote-control/application/remote-video-session.test.ts \
  packages/server/lib/remote-control/remote-authorization.test.ts
```

Then run:

```bash
PATH=/Users/caoqu/.bun/bin:/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/core build
PATH=/Users/caoqu/.bun/bin:/opt/homebrew/opt/node@22/bin:$PATH bun run --cwd packages/server build
```

Expected: all focused tests and both package builds pass. If a test or build fails, fix the implementation or test and rerun until it passes.
