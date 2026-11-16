# Remote video recovery implementation plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Repair recent lost video packets without bypassing pacing, retaining unbounded history, or repeatedly repairing obsolete frames.

**Architecture:** The approved recovery design places sequence coverage, byte/time limits, RTT retry intervals and keyframe boundaries in pure Core. The application pacer serializes primary and recovery writes under one aggregate budget with a smaller repair allowance. A per-sender werift adapter intercepts Generic NACK before the library's fixed history handler, while delegating other RTCP and preserving feedback events.

**Tech Stack:** TypeScript Core, ESM server adapters, installed werift 0.24.4, Node 22.22.0, Vitest.

## Global constraints

- Preserve existing dirty changes. No dependency edits, node_modules patches, deployment or unsolicited commit.
- Project CLAUDE.md requires pure Core and interfaces/ports; docs/code-standards.md is absent.
- Keep research and implementation history outside project docs. The user has approved bounded history, shared pacing and deadline/keyframe fallback.
- Keep H264/RTP and existing browser negotiation. QUIC, BBR2 and native RS-FEC have no confirmed compatible browser activation path.
- History hard limits: 8 MiB, 8192 packets, 2000 ms; repair queue: 256 KiB / 256 packets. Retry allowance: 3 repairs with RTT-based spacing; keyframe requests remain coalesced at 1000 ms.
- Repair allowance is 20% of target video bitrate and also consumes the existing aggregate pacing budget. Time and transport work enter through ports.

### Task 1: Domain recovery and pacing

**Files:** Create `packages/core/src/domain/live-view/remote-video-recovery.ts` and its test; modify `remote-video-pacing.ts`, its test, and domain `index.ts`.

**Interfaces:** `RemoteVideoRecoveryHistory<T>` records opaque packet values with wire sequence, bytes, keyframe-start and frame deadline; `request(sequence, now)` reserves one bounded repair; `beginRepair(entry, now)` rechecks deadline and generation. All results explicitly distinguish repair/send, ignore and keyframe recovery. `RemoteVideoPacingPolicy.delayForRepair/consumeRepair` share aggregate tokens and reserve a bounded repair share.

- [x] Implement history expiry as `min(sentAt + 2000, frameDeadline + clamp(2*RTT+50,150,1000))`. Preserve long-keyframe send allowance, ignore NACK before the newest keyframe/future sequences, deduplicate pending repairs, and retire history on failure.
- [x] Add aggregate/recovery token checks; e.g. `delayForRepair(bytes, now) = max(delayFor(bytes, now), repairDeficitMs)`.
- [x] Verify wraparound, >128 packets, memory and age limits, RTT retry spacing, expiry, retry exhaustion and superseded IDR references.

### Task 2: One serial application sender

**Files:** Modify `packages/server/lib/remote-control/application/paced-video-sender.mjs` and its test.

**Interfaces:** Add `enqueueRepair({value,bytes,expiresAt})` and writer/expiry ports. A repair write uses the same drain loop as a primary write. Primary writers receive frame deadline and first-packet context for history recording.

- [x] Bound the recovery queue, recheck deadlines before writing, select budget-ready repair work without starving primary work, and include the next deadline when scheduling timers.
- [x] Clear queued repairs on pause, recovery and fresh keyframes; preserve in-flight serialization across generations.
- [x] Verify no parallel writes, combined rate bounds, primary progress during repair deficit, deadline cancellation and stopped-generation isolation.

### Task 3: Werift integration and regression evidence

**Files:** Create `packages/server/lib/remote-control/infrastructure/werift-video-recovery.mjs` and its test; modify `werift-video-transport.mjs`, its test, and focused telemetry fields if needed.

**Interfaces:** Adapter takes sender, Core history, pacer and clock ports. Record final negotiated wire RTP after primary send; route NACK through history and paced repairs; send retransmissions directly through existing DTLS with unchanged original RTP identity or negotiated RTX wrapping. Restore the original per-instance RTCP handler on dispose.

- [x] Preserve non-NACK feedback and statistics; validate media SSRC and bound NACK batch work. Clone retained wire data and refresh negotiated transport timing extensions on repairs.
- [x] Reset history and repair queue on pause/stop and fresh keyframes; share existing keyframe request throttling. Pass valid RTT samples to history and bitrate updates to pacing.
- [x] Reproduce the original 256-packet/32-NACK case with a real werift sender and an injected transport; then exercise negotiated RTP/RTCP over local UDP with induced loss, asserting recovered bytes and original sequence/timestamp/marker values.

## Final unit test verification

- [x] Main agent: run Core recovery/pacing, application sender, adapter, transport and remote-session tests using Node 22.22.0 Vitest. Fix failures and rerun affected suites.
- [x] Build Core exports/declarations, run focused strict TypeScript verification, and run WebApp no-emit checking for shared type compatibility.
- [x] Save exact test commands and outputs in `/Users/caoqu/Documents/Codex/2026-11-10/remote-video-recovery-verification/`. Capture the verified fix and remaining real-phone acceptance boundary to wiki.

## Completed verification

68 tests / 10 files passed on Node 22.22.0, including delayed SRTCP NACK recovery over real local UDP. Core bundle/declarations, strict domain checking, WebApp no-emit, actual built-export smoke, ESM syntax and diff whitespace checks passed. A Core build conflict was resolved by removing the obsolete better-sqlite3 ambient declaration now shadowing the installed official types; SQLite runtime code was unchanged and 10 existing tests passed. Evidence: `/Users/caoqu/Documents/Codex/2026-11-10/remote-video-recovery-verification/report.md`. No deployment or real-phone acceptance.
