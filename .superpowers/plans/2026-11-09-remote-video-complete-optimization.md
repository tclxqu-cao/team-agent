# Complete remote desktop optimization plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Complete the remaining enumerated Mac and Windows remote-video optimizations and validate their actual integration.

**Architecture:** Pure Core policies own quality repair, dirty/interaction priorities, in-flight windows, keyframe cadence, input coalescing and frame QoE. Native adapters extract/cache pixels and measure scroll/cursor metadata. Negotiated browser adapters reconstruct scrolls, decompress bounded messages, render a separate cursor and report actual presentation.

**Tech Stack:** TypeScript/ESM, Swift/VideoToolbox, Windows C++/Media Foundation/WIC/DXGI, werift, Canvas, Zstd WASM with a browser decoder.

## Global constraints

- Preserve all pre-existing dirty work; project uses ordinary Git. No automatic push, deployment, service restart, installed helper replacement or shared dist writes.
- Node >=22.22.0; browser imports remain free of Node APIs. DDD decisions remain in Core.
- Explicit feature/format negotiation, bounded memory/work, ACK-before-cache reuse, epoch/revision/actual RTP presentation gating and backwards fallback remain mandatory.
- Implement all enumerated remaining items; tests/builds are distinct from native runtime acceptance. Windows binary construction does not prove Windows runtime behavior.
- User has approved the prior remaining-items list and requested complete implementation; use engineering judgment without repeated design confirmation. Plans stay in .superpowers; no project docs changes.

### 1. Core quality, input, QoE and window policies

**Files:** domain/live-view remote-compound-quality.ts, remote-frame-qoe.ts, remote-input-coalescer.ts, remote-video-encode-admission.ts and tests/exports.

- [x] Implement `RemoteCompoundQualityPolicy.invalidate(frame,rects,now)`, `priorities(now)`, `acknowledge(tiles)`, `noteInteraction(point,now)`; prioritize dirty/aged blocks and interaction proximity, allow higher-entropy repairs after idle.
- [x] Implement `remoteVideoKeyframeInterval(maxFps,reason)` and pass explicit numeric GOP limits into both adapters.
- [x] Implement `RemoteInputCoalescer<T>.offer(value,kind)`/`.shift()`; coalesce only adjacent hover moves, preserve drag/down/up/keys and acknowledge replaced requests.
- [x] Implement bounded `RemoteFrameQoe` records for send/presentation, NTP-style offset samples and uncertainty; report measured feedback RTT separately from clock-corrected capture-to-presentation estimates.
- [x] Implement bounded window admission (at most4 batches/64KB), retain ACK-only reusable assets and unique reserved IDs across abandoned batches.

### 2. Native incremental extraction and scroll measurement

**Files:** CompoundVideo.swift, Windows compound.cpp/remote.hpp, native-compound-video.mjs, native-video-encoder.mjs, main.swift/main.cpp, build script.

- [x] Hash raw pixels before PNG; bounded worker-owned encoded-image caches preserve entropy/PNG across revisions. Core supplies prioritized block indices and entropy limits.
- [x] Measure bounded vertical/horizontal arbitrary-pixel scroll candidates against retained previous pixels, verify overlap and confidence; emit source revision plus overlap geometry. Protocol only copies a verified previous layer and preserves transparent areas.
- [x] Preserve immutable pixel versions and capture timestamps through real encoder admission. Add repeat-cache, scroll and stale-version self-tests.
- [x] Windows exposes versioned start/tuning/stats, compound-enable/sample and cursor capability receipts; legacy helper versions remain on existing Baseline commands. Serialize native work off the input loop with a one-latest-frame queue; enforce dynamic bitrate/FPS/GOP and retain keyframe requests on deferred/failed submissions.

### 3. Protocol/application/receiver integration

**Files:** compound-video-session.mjs, remote-video-session.mjs, werift-video-transport.mjs, compound-video-wire.ts, BrowserCompoundVideo and tests.

- [x] Negotiate window-v1, scroll-v1 and qoe-v1; replace the single pending slot with a count/byte bounded map and a browser serial batch queue. Exclude in-flight placements from later sampling plans.
- [x] Preserve the previous canvas at invalidation for bounded scroll reconstruction; validate source/current revisions, geometry, sequence and RTP barriers. ACK copies before suppressing fully covered repair blocks.
- [x] Add bounded ARCZ Zstd framing; compress only when smaller, fall back to binary/JSON, validate decompressed size/window before browser decompression. Keep compression in infrastructure and account actual wire bytes.
- [x] Collect real requestVideoFrameCallback presentation receipts with bounded clock synchronization and log aggregate QoE; optional feedback never blocks H264.

### 4. Input and independent cursor

**Files:** remote-authorization.mjs, new browser cursor adapter, BrowserLivePanel.tsx, native capture/cursor code, helper managers/transport and CSS.

- [x] Apply Core hover coalescing before the helper input queue and return receipts for superseded tokens; preserve all key/button boundaries and active-drag points.
- [x] Negotiate a dedicated unordered cursor DataChannel. Mac/Windows exclude supported cursor compositing only while that feature is active; publish normalized position/shape/visibility and a cutover video timestamp.
- [x] Browser renders the independent cursor with video geometry and cutover gating, gives immediate local pointer feedback, and cleans channels/timers/overlays on disconnect. Legacy/failure paths restore captured cursor.

## Final unit test verification

- [x] Run `bunx vitest run packages/core/src/domain/live-view packages/core/src/infrastructure/live-view packages/server/lib/remote-control packages/desktop/main/webrtc-live.test.ts packages/desktop/renderer/components/remote-compound-video.test.ts packages/desktop/renderer/components/BrowserLivePanel.test.ts` plus new browser cursor tests; fix failures and rerun.
- [x] Strict focused TS and isolated Core/server/browser/WebApp builds; Node22 compiled composition and real DataChannel tests.
- [x] Build Mac helper only in temporary output; run existing and new native self-tests. Cross-compile Windows helper and run portable C++ algorithms; use Windows runtime/CI if available, otherwise explicitly record the missing native runtime acceptance.
- [x] One new ego-browser task verifies H264+compressed/window/scroll/presentation/cursor/fallback and cleanup with pixel/state evidence.
- [x] Review only owned diffs against project DDD/bounds, save source hashes and validation evidence, capture reusable findings to wiki and suggest docs sync without editing docs.

## Delivery evidence and acceptance limits

- Implemented all enumerated development items. Windows uses a synchronous worker and latest DXGI capture rather than an unnecessary extra pixel queue; one frame is admitted and DXGI coalescing is measured.
- Final 33 files / 322 unit tests, focused TS, isolated Core/server/browser/WebApp builds, Node22 composition, seven Mac native self-tests, Windows x64 cross-build and portable C++ pixel-scroll test passed.
- Combined browser task103 verified H264, Zstd896→192 bytes, all four delayed batches, 17px scroll/exposure repair, separate cursor/local feedback, presentation receipts, fallback and cleanup. Task and test server closed.
- No Windows native runtime was available. The Windows interactive verification script now covers v2; its real execution remains an acceptance prerequisite, not an unimplemented feature.
- Full WebApp types retain six existing untouched-file errors. No runtime deployment, install, commit or push was performed.
- Evidence: `/Users/caoqu/Documents/Codex/2026-11-09/remote-complete-optimization-verification/manifest.json`.
