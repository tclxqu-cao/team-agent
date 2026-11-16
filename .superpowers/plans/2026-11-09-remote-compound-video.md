# Browser-compatible compound remote video implementation plan

> **For the main agent:** Implement directly in the current session. Do not dispatch implementation or code-review subagents. Run affected tests after the implementation, fix failures, and report validation.

**Goal:** Add lossless region updates and acknowledged bitmap reuse to the Mac native remote video path, retaining H264 video and JPEG fallback.

**Approved design:** The user approved the preceding compound-video pipeline and asked to implement it. Domain policy owns classification limits, cache identity, geometry, update planning and bandwidth allocation. Application coordinators own session generation, native samples, acknowledgement windows, invalidation and RTP presentation barriers. Native extraction, PNG encoding, SCTP and Canvas are infrastructure. Implement browser-compatible PNG patches first; no ToDesk wire format or proprietary code is copied.

**Tech stack:** Existing TypeScript/Core, Node ESM/werift, Swift/CoreVideo/ImageIO/CryptoKit and browser Canvas/image decoding; no new dependencies.

## Constraints

- Preserve unrelated dirty changes and existing pacing work. Do not commit, push, deploy, restart or replace the installed helper.
- Project CLAUDE.md applies; docs/code-standards.md is absent. Keep plans under .superpowers and leave project docs unchanged.
- Use an explicitly negotiated version-1 reliable ordered DataChannel. Old/native-unsupported senders and viewers retain H264.
- Decode ordinary PNG tiles, not Zstd in the browser. Bound tile dimensions, canvas area, payload size, decoded cache pixels, native work and in-flight patch batches.
- Capture changes clear tile placements but retain acknowledged content assets. Reuse identical assets at new coordinates for scrolling/repeated UI.
- Every displayed patch requires a matching source epoch/revision AND a barrier for the currently presented video RTP timestamp. Missing barriers hide the overlay. Missing RTP metadata disables only the enhancement.
- Background, reconnect, resize, capture restart, stopped streams and rejected acknowledgements invalidate pending work. Asynchronous decoding cannot resurrect old patches.
- Reserve a small share of the total bitrate for enhancement, reducing the H264 allocation when enhancement is active.

## Task 1: Domain contract and policy

Files: packages/core/src/domain/live-view/remote-compound-video.ts; remote-compound-video.test.ts; index.ts.

Interfaces: CompoundFrameIdentity { epoch, revision, timestamp, width, height }; CompoundTileDescriptor { key, x, y, width, height, entropy, bytes }; RemoteCompoundVideoPolicy.plan(frame, tiles, byteBudget), acknowledge(plan), invalidate(frame), reset(); splitCompoundVideoBitRate(bitRate, enabled).

- [x] Define version/geometry/memory limits and pure immutable DTOs.
- [x] Implement unchanged placement suppression, acknowledged cache references, bounded new-asset planning and cache reset when capacity is exhausted.
- [x] Reject stale epochs/revisions and out-of-bounds tiles; only acknowledge the exact current plan.
- [x] Cover reuse at scrolled coordinates, failed/late acknowledgements, cache exhaustion, entropy classification and budget boundaries.

## Task 2: Native sampling adapter

Files: packages/server/native/remote-helper/service/CompoundVideo.swift; main.swift; scripts/build-cli-remote-helper.mjs; helper-manager.mjs; infrastructure/native-video-encoder.mjs.

Interfaces: helper.onCompound(listener); encoder.enableCompound(enabled), sampleCompound(maxBytes), onCompound(listener). Native ops compound-enable and compound-sample. Native events identify capture epoch/revision and accepted H264 timestamps.

- [x] Add bounded off-main-thread BGRA tile measurement, SHA256 identity and PNG encoding with round-robin selection.
- [x] Emit invalidation on changed capture content and frame metadata for accepted H264 input; use the same clock for keepalive frames.
- [x] Reset generation and sample state across capture/encoder lifecycle transitions. Drop asynchronous samples whose revision changed.
- [x] Add a permission-free native self-test with synthetic frames for classification, edge tiles, exact cache identity and PNG decoding.
- [x] Include the Swift source in normal helper packaging; build only into a temporary output during validation.

## Task 3: Application and transport integration

Files: application/compound-video-session.mjs and test; application/remote-video-session.mjs and test; infrastructure/werift-video-transport.mjs and test; remote-video-signal.mjs and test.

Interfaces: CompoundVideoSession({ encoder, transport, clock, onAllocationChanged, log }); start(), stop(), pause(), resume(), frameSent(frame), handleMessage(message), videoDecision(decision).

- [x] Negotiate compoundVersion:1 in viewer start; create the data channel only for a compatible session.
- [x] Validate native tile envelopes and image headers at the adapter boundary; enforce bounded JSON/DataChannel writes.
- [x] Track one acknowledged patch batch, expire missing acknowledgements, reset caches, coalesce sampling and skip future/obsolete samples.
- [x] Correlate actual paced frame delivery with native frame identity and emit video presentation barriers.
- [x] Partition total bitrate and stop timers/listeners on pause, failure, fallback and generation changes; enhancement failures keep H264 running.
- [x] Test stale callbacks, reconnect/resize, backpressure, unsupported helper, invalid payloads, acknowledgement timeout and real werift data-channel negotiation.

## Task 4: Browser reconstruction

Files: packages/desktop/renderer/components/remote-compound-video.ts and test; BrowserLivePanel.tsx; existing browser-live stylesheet.

Interfaces: BrowserCompoundVideo({ getVideo, getCanvas, decodeImage }); attach(peer), presentFrame(rtpTimestamp), receive(message), stop().

- [x] Add a pointer-transparent overlay matching the existing video layout and attach it when answering an offer.
- [x] Validate tile/reset/frame envelopes and keep decoded images within explicit cache limits.
- [x] Process bitmap patches asynchronously while frame barriers remain responsive; acknowledge only successful cache admission.
- [x] Hide on unmatched frames and invalidate on revision/epoch changes. Close decoded image resources after invalidation and teardown.
- [x] Negotiate only with required browser primitives and disable safely if RTP metadata is unavailable.
- [x] Exercise async decode races, scroll reuse, RTP wraparound, cache reset and unsupported metadata in meaningful behavior tests.

## Final verification

- [x] Run affected Core, remote-control, BrowserLivePanel and compositor unit tests after implementation.
- [x] Run focused strict TypeScript checks and isolated Core/server/browser builds without overwriting shared dist.
- [x] Build helper into temporary paths and run compound self-test and existing permission-free helper self-tests.
- [x] Use ego-browser for a synthetic browser composition journey with a real video frame and PNG asset; inspect rendered pixels and cleanup.
- [x] Self-review the owned diff for DDD, bounded resource use, lifecycle races and regression risk.
- [x] Capture reusable findings in wiki; report source-only status and runtime acceptance limits.

## Verification outcome

269 tests across 25 files passed. Six permission-free native self-tests passed. Focused strict TypeScript, isolated Core/server/WebApp builds, Node 22.22.0 composition smoke and ego-browser real-H264 pixel checks passed. Full WebApp typecheck still reports four SQLite declaration errors and two client-error-reporter nullability errors in untouched files. No runtime activation was performed. Evidence: /Users/caoqu/Documents/Codex/2026-11-09/remote-compound-verification/manifest.json.
