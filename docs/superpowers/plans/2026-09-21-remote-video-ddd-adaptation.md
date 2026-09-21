# Remote Video DDD Adaptation Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement shared content-aware remote-video adaptation, native encoder queue feedback, H.264 High-to-Baseline fallback, and evidence-based decoder diagnostics while restoring DDD boundaries.

**Architecture:** `@agent/core` owns framework-independent media types and `RemoteVideoPolicy`. Server and Electron application coordinators consume that policy through native-helper/werift and Chromium adapters respectively; WebRTC wire validation stays at the server boundary, while `LiveViewRegistry` enforces only ownership and relay invariants.

**Tech Stack:** TypeScript, JavaScript ESM, Vitest, Electron/Chromium WebRTC, werift, Swift, ScreenCaptureKit, VideoToolbox.

## Global Constraints

- Keep CLI and Electron capture/encode implementations independent; share only domain contracts and policy.
- Preserve binary H.264 IPC, TURN configuration, JPEG fallback, display switching, ownership, and input behavior.
- Keep resolution fixed within the user-selected `smooth`, `hd`, or `original` ceiling.
- Use 5/15/30 FPS activity targets with fast promotion and delayed idle demotion.
- Prefer H.264 High only when both endpoints prove support; retry Baseline at most once.
- Do not infer hardware decoding from implementation-name substrings.
- Main agent implements directly without subagents.

---

### Task 1: Shared Remote Video Domain

**Files:**
- Create: `packages/core/src/domain/live-view/remote-video-types.ts`
- Create: `packages/core/src/domain/live-view/remote-video-policy.ts`
- Create: `packages/core/src/domain/live-view/remote-video-policy.test.ts`
- Modify: `packages/core/src/domain/live-view/index.ts`

**Interfaces:**
- Consumes: quality names `smooth | hd | original` and normalized adapter observations.
- Produces: `RemoteVideoPolicy`, `RemoteVideoDecision`, `RemoteVideoObservation`, `RemoteVideoAdapterCapabilities`, codec and decoder diagnostic types.

- [x] **Step 1: Define framework-independent contracts**

Add bounded value types for content activity, network telemetry, encoder telemetry, adapter capabilities, codec support, decoder evidence, and policy decisions. Keep browser and native DTO names out of core.

- [x] **Step 2: Implement the policy state machine**

Implement quality ceilings, network adaptation, queue-pressure precedence, 5/15/30 FPS content hysteresis, capability intersection, and one-way High-to-Baseline fallback state.

- [x] **Step 3: Add deterministic policy tests**

Cover idle delay, immediate interactive promotion, motion promotion, congestion, queue pressure, recovery, missing telemetry, codec capability intersection, and single fallback.

- [x] **Step 4: Export the contracts and policy**

Export them from the live-view domain index so server, desktop main, and renderer can import through `@agent/core`.

### Task 2: WebRTC Wire Boundary And Registry Ownership

**Files:**
- Create: `packages/server/lib/remote-control/remote-video-signal.mjs`
- Create: `packages/server/lib/remote-control/remote-video-signal.test.ts`
- Modify: `packages/server/ws-server.mjs`
- Modify: `packages/core/src/domain/live-view/live-view-registry.ts`
- Modify: `packages/core/src/domain/live-view/live-view-registry.test.ts`

**Interfaces:**
- Consumes: raw `browser:webrtc` and `browser:webrtc-relay` payloads.
- Produces: bounded `parseViewerRemoteVideoSignal()` and `parseProducerRemoteVideoSignal()` results passed to registry relay methods.

- [x] **Step 1: Move protocol validation to the server boundary**

Extract bounded validation for SDP, ICE servers/candidates, stats, codec capabilities, quality, tuning state, and decoder diagnostics into the new parser module.

- [x] **Step 2: Keep only domain invariants in the registry**

Remove SDP, ICE, TURN, and stats-shape helpers from `LiveViewRegistry`. Preserve controller ownership, quality-adjustment authorization, producer identity, and quality-state broadcast behavior.

- [x] **Step 3: Wire parsers into WebSocket handlers and disconnect cleanup**

Parse before invoking registry methods, including synthetic stop on disconnect.

- [x] **Step 4: Update focused tests**

Move malformed-wire assertions to parser tests and retain registry tests for ownership and routing only.

### Task 3: Server Application Coordinator And Infrastructure Adapters

**Files:**
- Create: `packages/server/lib/remote-control/application/remote-video-session.mjs`
- Create: `packages/server/lib/remote-control/application/remote-video-session.test.ts`
- Create: `packages/server/lib/remote-control/infrastructure/werift-video-transport.mjs`
- Create: `packages/server/lib/remote-control/infrastructure/werift-video-transport.test.ts`
- Create: `packages/server/lib/remote-control/infrastructure/native-video-encoder.mjs`
- Create: `packages/server/lib/remote-control/infrastructure/native-video-encoder.test.ts`
- Modify: `packages/server/lib/remote-control/webrtc-video.mjs`
- Modify: `packages/server/lib/remote-control/webrtc-video.test.ts`
- Modify: `packages/server/lib/remote-control/remote-authorization.mjs`
- Remove: `packages/server/lib/remote-control/video-adaptation.mjs`
- Remove: `packages/server/lib/remote-control/video-adaptation.test.ts`

**Interfaces:**
- Consumes: `RemoteVideoPolicy`, helper control/binary video port, werift transport callbacks, validated viewer signals.
- Produces: `RemoteVideoSession` application service plus a compatibility `RemoteWebrtcVideo` export for the existing caller.

- [x] **Step 1: Extract H.264 packetization and werift lifecycle**

Move peer creation, codec offer ordering, RTP writes, ICE/RTCP handling, sender stats, and connection lifecycle into `WeriftVideoTransport`.

- [x] **Step 2: Add the native helper adapter**

Map policy decisions to `video-start`, `video-tuning`, `video-stats`, keyframe, and stop commands. Declare native capabilities and normalize helper telemetry.

- [x] **Step 3: Implement the application coordinator**

Coordinate generation-safe start/stop/pause/resume, coalesced tuning, network/activity/encoder samples, negotiated codec, first-frame timeout, and one Baseline retry.

- [x] **Step 4: Preserve the existing entry point**

Make `webrtc-video.mjs` a narrow compatibility export and update `RemoteAuthorization` only where the validated signal/capability contract changes.

- [x] **Step 5: Add focused adapter and coordinator tests**

Cover packetization, codec ordering, stale generations, coalesced tuning, High fallback, helper telemetry absence, and JPEG failure signaling.

### Task 4: Native Content And Encoder Feedback

**Files:**
- Modify: `packages/server/native/remote-helper/service/VideoEncoder.swift`
- Modify: `packages/server/native/remote-helper/main.swift`
- Modify: `packages/server/lib/remote-control/helper-manager.mjs`
- Modify: `packages/server/lib/remote-control/helper-manager.test.ts`

**Interfaces:**
- Consumes: profile-selectable `video-start` and dynamic `video-tuning` commands.
- Produces: bounded `video-stats` snapshots containing activity, pending encodes, latency, drops, profile, and sequence.

- [x] **Step 1: Add generation-safe encoder telemetry**

Track pending submissions, callback latency, pacing drops, encode failures, callback failures, and monotonic snapshot sequence. Ignore late callbacks from an invalidated session generation.

- [x] **Step 2: Add profile-selectable encoder startup**

Map `high` and `baseline` to VideoToolbox constants, check property/prepare return codes, and return an explicit error when High is unavailable.

- [x] **Step 3: Normalize ScreenCaptureKit activity**

Use complete/idle frame status, dirty-region coverage when present, and recent cadence to emit `idle`, `interactive`, or `motion` with confidence without exposing ScreenCaptureKit DTOs.

- [x] **Step 4: Extend helper commands and JavaScript tests**

Add `video-start` and `video-stats` replies while keeping `video` compatibility during migration. Test bounded command/reply behavior and binary channel independence.

### Task 5: Electron Browser Sender Adapter

**Files:**
- Create: `packages/desktop/main/remote-video-browser-policy.ts`
- Create: `packages/desktop/main/remote-video-browser-policy.test.ts`
- Modify: `packages/desktop/main/webrtc-live.ts`
- Modify: `packages/desktop/main/webrtc-live.test.ts`
- Modify: `packages/desktop/assets/webrtc-live.html`

**Interfaces:**
- Consumes: normalized sender activity/network observations from the hidden page and shared `RemoteVideoPolicy` decisions from desktop main.
- Produces: browser tuning messages mapped to `track.applyConstraints`, `sender.setParameters`, and `transceiver.setCodecPreferences` with declared capabilities.

- [x] **Step 1: Add the desktop application policy coordinator**

Instantiate the shared policy in desktop main, serialize decisions, reset per capture generation, and perform one Baseline-only restart when High fails.

- [x] **Step 2: Extend the hidden-page adapter**

Report codec capabilities and normalized outgoing stats/activity. Apply max FPS, bitrate, maintain-resolution, and codec preferences only when the browser exposes the corresponding API.

- [x] **Step 3: Preserve fallback and lifecycle semantics**

Keep JPEG standby transitions, start timeout, reconnect grace, display restart, and window cleanup unchanged across adaptation restarts.

- [x] **Step 4: Add focused tests**

Test capability declaration, tuning messages, unsupported queue telemetry, High-to-Baseline restart, and stale hidden-page signals.

### Task 6: Shared Receiver Diagnostics

**Files:**
- Modify: `packages/desktop/renderer/components/remote-video-stats.ts`
- Modify: `packages/desktop/renderer/components/remote-video-stats.test.ts`
- Modify: `packages/desktop/renderer/components/BrowserLivePanel.tsx`

**Interfaces:**
- Consumes: inbound browser stats and shared decoder diagnostic types from `@agent/core`.
- Produces: bounded raw decoder implementation, power-efficiency evidence, hardware/software/unknown classification, selected H.264 profile, and renderer labels.

- [x] **Step 1: Use shared telemetry and diagnostic types**

Replace duplicate receiver sample types with type-only imports where possible and keep the browser stats cursor renderer-local.

- [x] **Step 2: Parse reliable decoder evidence**

Preserve bounded implementation and classify acceleration only from explicit reliable booleans; never inspect implementation-name substrings.

- [x] **Step 3: Render diagnostics without crowding the compact status**

Keep route/codec/resolution/bitrate/RTT in the primary label and add a short secondary decoder diagnostic visible only when evidence exists.

- [x] **Step 4: Add focused parser/formatter tests**

Cover hardware, software, unknown, absent fields, bounded implementation text, and existing TURN/P2P/JPEG labels.

### Task 7: Documentation And Migration Cleanup

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-remote-video-ddd-adaptation-design.md` only if implementation reveals a contract correction.
- Modify: `docs/superpowers/plans/2026-09-21-remote-video-ddd-adaptation.md`

**Interfaces:**
- Consumes: final implementation and verification evidence.
- Produces: checked task status and accurate remaining acceptance boundaries.

- [x] **Step 1: Remove obsolete imports and duplicate contracts**

Confirm no caller imports server-local `VideoAdaptation`, no registry helper parses raw WebRTC DTOs, and no renderer telemetry contract duplicates shared core types.

- [x] **Step 2: Mark completed plan tasks and record real limitations**

Keep TURN credential-dependent and browser-specific stats availability explicit. Do not claim hardware decoding or High Profile when runtime evidence is absent.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run \
  packages/core/src/domain/live-view/remote-video-policy.test.ts \
  packages/core/src/domain/live-view/live-view-registry.test.ts \
  packages/server/lib/remote-control/remote-video-signal.test.ts \
  packages/server/lib/remote-control/application/remote-video-session.test.ts \
  packages/server/lib/remote-control/infrastructure/werift-video-transport.test.ts \
  packages/server/lib/remote-control/infrastructure/native-video-encoder.test.ts \
  packages/server/lib/remote-control/helper-manager.test.ts \
  packages/server/lib/remote-control/webrtc-video.test.ts \
  packages/desktop/main/remote-video-browser-policy.test.ts \
  packages/desktop/main/webrtc-live.test.ts \
  packages/desktop/renderer/components/remote-video-stats.test.ts
```

Expected: PASS.

Then run:

```bash
bun run --cwd packages/core build
bun run --cwd packages/desktop compile
bun run build:server
bash packages/server/native/remote-helper/build.sh
```

Expected: all builds pass. If a command differs from the repository scripts, use the nearest existing package script and record the exact command used. Fix failures and rerun until passing.

## Verification Record

- 74 affected tests passed across core policy/registry, signal parsing, application coordination, native/werift adapters, helper IPC, remote authorization, Electron policy/coordination, and receiver diagnostics.
- `bun run --cwd packages/core build`, `bun run --cwd packages/desktop compile`, and `bun run --cwd packages/server build` passed. The server build retained its pre-existing dynamic dependency warning for `@agent/core`.
- `node scripts/build-cli-remote-helper.mjs` compiled and ad-hoc signed the helper; `--quality-self-test` reported `high` and `baseline`. The only Swift warning is the pre-existing macOS 14 deprecation of `activateIgnoringOtherApps`.
- Full `bun run test`: 2385 passed, 2 skipped, 9 failed in unrelated sidebar/chat-history/session-fork/UI-store contract tests. No remote-video test failed.
- Full root `bun run lint` remains red on pre-existing repository-wide test/declaration issues. The scoped core build and desktop TypeScript compile pass.
- TURN relay remains credential-dependent. High Profile selection and hardware decoding are implemented as capability-driven diagnostics but are not claimed as runtime-verified until a real session reports the selected profile and `powerEfficientDecoder` evidence.
