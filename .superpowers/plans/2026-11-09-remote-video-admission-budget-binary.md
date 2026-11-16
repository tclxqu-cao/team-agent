# Remote video admission, adaptive budget and binary patches

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Bound native encoding latency, allocate enhancement bandwidth according to demand and pressure, and reduce patch wire overhead without losing existing H264 or JSON compatibility.

**Architecture:** Core owns admission limits, bandwidth decisions and acknowledged cache identities. Application code coordinates observations, credits, format negotiation and exact frame identities. Swift, werift and browser adapters execute admission and encode/decode the wire format.

**Tech Stack:** TypeScript, JavaScript ESM, Swift/VideoToolbox, werift DataChannel, browser Canvas, Vitest.

## Global Constraints

- Preserve unrelated dirty work; ordinary Git only; no unsolicited commit, push, restart, helper installation or shared dist replacement.
- Node >=22.22.0; no new dependency or workspace package.
- Keep standard H264 and `agentroam.compound.v1`; binary tiles require an explicit `formats` ready receipt; JSON remains the default.
- One patch batch awaiting ACK; bounded messages 48,000 bytes, 128 tiles, 4096 cache entries and 10,485,760 cached pixels.
- Core has no DOM, Node, VideoToolbox or wire codec dependencies. Project docs are not edited.
- Static ToDesk findings motivate independent implementation; thresholds and wire layout are AgentRoam choices.

### Task 1: Domain policies and acknowledged cache IDs

**Files:** Core `domain/live-view/remote-video-encode-admission.ts`, `remote-compound-budget.ts`, `remote-compound-video.ts`, domain exports, and adjacent tests.

**Interfaces:** `remoteVideoEncodeAdmission(maxFps): {maxPendingFrames:number}`; `RemoteCompoundBudgetPolicy.observe(observation)`, `.noteDemand(bytes, now)`, `.allocation(bitRate, enabled, now)`; cache plans carry `cacheId` and accept a numeric cost model.

- [x] Add pure policies: `maxPendingFrames = maxFps >= 20 ? 2 : 1`; invalid FPS falls back to one. Pressure uses loss, available bitrate, queue delay and encoder delay, never RTT alone.
- [x] Allocate a small control allowance, up to 20% for demanded patches, keep H264 >=250kbps, hold demand briefly then decay when idle. Disable patches below500kbps.
- [x] Assign IDs from acknowledged assets plus prospective puts; IDs commit only in `acknowledge(plan)` and reset with epoch/cache. Default JSON cost stays compatible; binary cost is header+epoch+10 bytes/tile+raw PNG bytes.
- [x] Cover conservation, idle decay, pressure recovery, long RTT, invalid inputs, ACK/reset IDs and binary-vs-JSON admission with unit assertions.

### Task 2: Native latest-frame admission

**Files:** `service/VideoEncoder.swift`, `service/CompoundVideo.swift`, `main.swift`, native encoder adapter, telemetry types.

**Interfaces:** `RemoteVideoContentVersion(epoch:revision:)`; `encode(pixel,timestamp:contentVersion:)`; `onSubmitted(pixel,timestamp,version)`; start/tuning accept `maxPendingFrames`.

- [x] Retain one latest offer and admit only below configured in-flight count and monotonic FPS deadline. Completion schedules main-thread drain. Replacement increments separate `coalescedFrames`, not encoder drops.
- [x] Reset/stop cancel scheduled drain and held buffer. Keyframe demand survives deferral; tuning reschedules; late callbacks are generation guarded.
- [x] Replace timestamp-equality hooks with successful-admission callback. `noteEncoded` rejects content versions superseded by capture changes.
- [x] Add `--encode-admission-self-test` using synthetic pixel buffers and actual VT callbacks; assert bounds, newest submission, tuning, stop, and stale content rejection without screen permission.

### Task 3: Shared binary wire adapter and browser receiver

**Files:** Core `infrastructure/live-view/compound-video-wire.ts` and tests, infrastructure export, werift transport and tests, browser compound controller and tests.

**Interfaces:** `encodeCompoundTiles(message): Uint8Array`; `decodeCompoundTiles(bytes): BinaryCompoundTiles`; transport `prepareCompound(message,format): {data,bytes}` and `sendCompound(prepared)`.

- [x] Encode ARCV v1 tiles: 30-byte header, UTF-8 epoch, 10-byte tile records and raw PNGs. Validate exact lengths, safe integers, IDs, geometry and PNG dimensions; reject truncation/trailing bytes.
- [x] Prepare JSON or binary in transport; charge UTF-8/raw byte length and enforce existing buffered amount/message bounds. Controls remain JSON.
- [x] Browser sets `binaryType = "arraybuffer"`, advertises `["binary-v1", "json-v1"]`, maps binary IDs into an internal slot namespace, and accepts string or byte PNG input.
- [x] Preserve exact RTP barriers, stale epoch/revision protection, async generation cancellation, image disposal and ACK semantics. JSON cannot forge internal cache slots. Corrupt binary disables enhancement only.
- [x] Cover real DataChannel bytes, JSON fallback, put/reuse, malformed packets, cache mismatch and asynchronous reset.

### Task 4: Application integration

**Files:** `application/compound-video-session.mjs`, `remote-video-session.mjs`, application tests.

**Interfaces:** `compound.observe(observation)`; prepared payload port; demand measured using actual prospective wire bytes.

- [x] Accrue credit using previous allocation before switching rates. Allocation changes notify session tuning; pressure observations arrive before new video decisions.
- [x] Discover demand using a bounded sample even when patch credit is small; prepare a prospective plan, feed actual wire length to policy, then re-plan against earned credits. One active sample and one ACK batch.
- [x] Select binary only after advertised support and adapter capability. Format changes invalidate cache/epoch. Old injected ports keep JSON fallback.
- [x] Cover bootstrap, no retroactive credit, idle/pressure allocation, ready-before-start, in-flight format switch, synchronous ACK, stale sampling, pause/stop and legacy timing.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/core/src/domain/live-view packages/core/src/infrastructure/live-view packages/server/lib/remote-control packages/desktop/main/webrtc-live.test.ts packages/desktop/renderer/components/remote-compound-video.test.ts packages/desktop/renderer/components/BrowserLivePanel.test.ts`
Expected: PASS; fix failures and rerun the affected command.

- [x] Focused strict TypeScript; isolated Core/server/browser/WebApp builds; Node22.22.0 compiled composition smoke.
- [x] Isolated native app build; admission and six existing permission-free self-tests.
- [x] New ego-browser task: real H264 and binary put/reuse, JSON fallback, stale epoch, partial invalidation, malformed packets and cleanup; close test server/task space.
- [x] Review owned diff against DDD and compatibility constraints; capture reusable results to wiki; report source-only status and real-phone acceptance limits. Suggest docs synchronization without editing docs.

## Verified refinements

- `RemoteCompoundVideoPolicy.markSent(plan)` reserves transmitted numeric IDs without making assets reusable. Abandoned unacknowledged batches cannot alias later content; exhausted IDs force an epoch reset.
- Oversized partial invalidations become conservative full clears when current maximum credit cannot hold the command.
- Windows compatibility steering: existing C++ helper protocol v1 keeps Baseline enable/disable. New dynamic/compound commands are capability gated; no Windows native enhancement was added or runtime-validated.
- Final result: 30 files / 306 tests, 7 native self-tests, focused strict TS and isolated builds passed. Browser task96 finished; actual H264 survives a corrupted binary packet. Full WebApp typecheck retains six known untouched-file errors.
- Durable evidence: `/Users/caoqu/Documents/Codex/2026-11-09/remote-admission-budget-binary-verification/manifest.json`.
