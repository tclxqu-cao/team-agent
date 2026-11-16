# Remote Video Pacing Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Smooth native remote-desktop RTP transmission, bound queued video age and memory, and react promptly to fresh congestion feedback.

**Architecture:** A framework-free core domain policy owns byte budgets, burst bounds and frame admission/deadlines. An application sender owns an opaque packet queue and coordinates injected clock, timer, async writer and recovery ports. Werift infrastructure normalizes H.264/RTCP and calls its existing async sender; RemoteVideoSession wires tuning, fresh feedback and lifecycle through ports.

**Tech Stack:** TypeScript domain, Node ESM application/infrastructure, werift 0.24.4, Vitest.

## Global Constraints

- User approved applying the preceding pacing/congestion proposal and explicitly requires DDD. No additional design-approval gate is needed.
- Domain code must not depend on Node, Buffer, werift, timers, sockets, capture or codecs beyond normalized keyframe metadata.
- docs/code-standards.md is absent. Follow CLAUDE.md; preserve unrelated dirty work and the earlier RTT/shortcut fixes.
- Keep WebRTC, H.264 negotiation, werift NACK/SRTP/RTCP and resolution contracts. No proprietary binary or recovered code is embedded.
- Do not modify project docs, rebuild shared dist, restart services, commit or push in this implementation task. Build verification uses private temporary output.
- Recover H.264 dependencies after discarded frames; allocate RTP sequence numbers only at actual transmission.
- Stable high RTT or sparse-stream low REMB alone must not trigger throttling. Recovery remains driven by periodic healthy samples.

### Task 1: Domain pacing and sender-pressure policy

**Files:** create `packages/core/src/domain/live-view/remote-video-pacing.ts` and its test; modify `remote-video-types.ts`, `remote-video-policy.ts`, its test and `index.ts`.

**Interfaces:** `RemoteVideoPacingPolicy.setBitRate(bitRate, now)`, `delayFor(bytes, now)`, `consume(bytes, now)`, `reset(now)`, `frameLifetimeMs(bytes, keyFrame)`, `overloaded({ bytes, frames, ageMs })`; exported immutable normalized sender telemetry.

- [x] Implement a token budget at 1.25 times encoding target, capped at 5ms of credit (at least one MTU), with explicit monotonic time and reset. Clamp invalid tuning inputs without poisoning the last valid rate.
- [x] Bound backlog at 250ms, eight frames and 8MiB; give keyframes a size-aware deadline capped at 2 seconds. Preserve an isolated large keyframe within the byte cap.
- [x] Reuse the existing network-pressure predicate for urgent feedback; incorporate normalized sender queue/drop pressure into periodic adaptation without conflating it with receiver loss.

```ts
export interface RemoteVideoSenderTelemetry {
  queuedBytes: number;
  queuedFrames: number;
  queueDelayMs: number;
  droppedFrames: number;
  pacingBitRate: number;
  waitingForKeyframe: boolean;
}
```

### Task 2: Application packet sender

**Files:** create `packages/server/lib/remote-control/application/paced-video-sender.mjs` and its test.

**Interfaces:** constructor receives policy, `write(packet): Promise<void>`, `clock.now()`, `clock.schedule(fn, ms)`, `clock.cancel(handle)`, `onKeyframe()` and `onError(error)`. `enqueue({ packets: [{value, bytes}], keyFrame })` returns acceptance; `setBitRate`, `pause`, `resume`, `stop`, `snapshot` coordinate the same instance.

- [x] Serialize async packet writes, replenish only bounded credit and schedule by the next packet's byte deficit. Recheck generation after every await.
- [x] Bound complete frame admission and expiry. Drop dependent queued frames on overflow/expiry, request a new keyframe at most once per second and reject deltas until one arrives. A new keyframe can supersede unsent backlog.
- [x] Cancel timers and queue data on pause/stop; late callbacks or completed writes must not revive a stopped generation. Snapshot sender drops as a consumed delta for the sampling loop.

### Task 3: Infrastructure and session integration

**Files:** modify `infrastructure/werift-video-transport.mjs`, its test, `application/remote-video-session.mjs`, its test and `webrtc-video.test.ts` as required by source-policy imports.

**Interfaces:** transport adds `setTuning(decision)`, `pause()`, `resume()`, and constructor `onFeedback(sample)` callback. Network snapshots carry a monotonic sample sequence and optional normalized sender telemetry.

- [x] Packetize H.264 in infrastructure, detect actual IDR NALs, enqueue opaque packets and reserve sequence numbers immediately before `sender.sendRtp(packet)`. Keep packetizeH264's existing public contract.
- [x] Normalize only relevant RTCP reports/REMB into feedback, reset freshness at start/stop, and deduplicate fast feedback against periodic snapshots. Keep PLI/FIR coalescing separate from bandwidth feedback.
- [x] Session applies congestion feedback at most once per second without accelerating healthy recovery; apply the same decision promptly to pacing and serial encoder tuning. Include sender metrics in existing sanitized decision logs.
- [x] Wire pause/resume/stop and reconnect isolation through optional transport ports so injected transports remain compatible.

Frame completion is reported separately from enqueue acceptance. `framesSent` and first-frame readiness advance only after a full paced frame finishes; `framesQueued` preserves admission accounting. Source-based tests override only the new core policy export to avoid accidentally loading stale shared dist.

## Final Unit Test Verification

- [x] Main agent: run the new domain/sender tests, all existing domain policy tests and server remote-control tests after implementation. Verify budget, event-loop stalls, rate changes, bounded memory, keyframe recovery, sequence continuity, blocked/rejected writes, stop/pause/reconnect and stale feedback.

Run: `bunx vitest run packages/core/src/domain/live-view packages/server/lib/remote-control packages/desktop/main/webrtc-live.test.ts`.

Result: 20 files / 202 tests passed. Includes a real UDP WebRTC negotiation and fragmented-frame arrival timing, and a >2MB original-quality keyframe pacing regression.
- [x] Extend the real local werift negotiation test with a fragmented frame. Assert intact payload/markers/sequence order and packet arrivals spread over time.
- [x] Run focused TypeScript checks for affected core files and an isolated core + server-entry build; do not replace shared artifacts. Review only this diff against DDD boundaries and capture findings and activation limits in wiki.

Result: focused strict TypeScript check passed for the domain policy/types and new unit-test files. Private Core + remote-video entry builds and compiled-entry import/construction smoke passed on Node 22.22.0. Artifacts: `/var/folders/6r/m9bbktwj1pvbr6hbzpxqkq3h0000gn/T/agentroam-video-pacing-build-20261109-eedp6_1m`. Initial smoke needed the server workspace's dependency directory, because Bun's isolated install does not hoist werift to root; only the private test directory's symlink was adjusted.
