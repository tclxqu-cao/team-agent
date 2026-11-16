# Receiver adaptation, cursor cache and static encoding implementation plan

> **For the main agent:** Implement directly, no subagents. After all tasks run affected tests and fix failures. Use checkboxes.

**Goal:** Complete all four approved candidates and preserve prior remote optimizations.
**Architecture:** Core owns receiver pressure, viewport sizing and hysteresis. Browser measures optional stats and visible viewport/zoom. Server validates and coordinates; native adapters resize capture, cache cursor shapes and suppress redundant encoding.
**Tech Stack:** TypeScript/ESM, React, Swift/ScreenCaptureKit/VideoToolbox, C++/Media Foundation/DXGI.

## Global constraints
- Preserve pre-existing dirty work, ordinary Git, no commit/push/deploy/restart/install or shared dist writes.
- Existing quality, aspect ratio, input mapping, compound epochs, ACK and RTP barriers, force-IDR and cursor restoration remain valid.
- Unknown stats are not congestion; ignore background/stale/counter-reset samples. Decoding pressure must not lower bitrate as network pressure.
- Keep original manual quality at native dimensions unless genuine receiver pressure; smooth/hd retain their existing ceilings. Quantize adaptive dimensions, 5-second switch cooldown and slow recovery.
- User explicitly postponed real-device capture. Run meaningful native self-tests/builds and browser/adapter tests; do not claim Windows/iPhone or capture acceptance.

### 1. Core receiver policy and contracts
Files: remote-video-types.ts, new remote-video-receiver.ts/test.ts, remote-video-policy.ts/index.ts.
- [x] Add bounded receiver observations (visible, decodedFrames, interval/decode/drop/presentation timing, frame dimensions and viewport/DPR/zoom), optional maxEdge decision and dynamicResolution capability.
- [x] Separate receiver FPS/size caps from transport caps. Require repeated evidenced pressure, healthy hysteresis and viewport sizing preserving aspect ratio. Missing/hidden/stale samples do not change caps.

### 2. Browser and server adapters
Files: remote-video-stats.ts/test.ts, BrowserLivePanel.tsx, remote-video-signal.mjs/test.ts, remote-video-session.mjs/test.ts, native-video-encoder.mjs/test.ts.
- [x] Measure counter deltas and decode duration, optional RVFC lateness, visibility and current viewport/zoom via refs. Reset on visibility/receiver change; do not treat missing or decreasing counters as pressure.
- [x] Validate nested receiver telemetry at signalling boundary. Apply each receiver sample once; transport observations stay independent. Forward maxEdge including explicit reset; preserve legacy helpers.

### 3. Native resolution and cursor
Files: Mac main.swift, VideoEncoder.swift, Cursor.swift; Windows video-pipeline.cpp/algorithms.hpp.
- [x] Apply optional maxEdge to Mac capture dimensions, coalescing updates with existing interaction sizing and ignoring obsolete streams. Clamp quality/source dimensions, reset enhanced content naturally on resized frames.
- [x] Apply same optional cap before Windows encoder input; preserve dimensions/compound version correspondence.
- [x] Cache encoded Mac cursor shape before repeated PNG work; cache key includes shape identity, hotspot, geometry and scale, periodically refresh to catch mutable shapes. Send changes plus heartbeat and shape resend for packet loss. Preserve cutover/visibility/activation resets. Add deterministic cache/emission self-tests.

### 4. Windows static suppression
Files: video.cpp, remote.hpp, video-pipeline.cpp, algorithms.hpp/algorithms-test.cpp.
- [x] Separate output drain from new encoder input. Drain queued MFT output even when static, skip identical input until 1-second keepalive, force input for IDR/reconfigure/display/cursor changes. Continue command/cursor handling.
- [x] Expose suppressed-frame counts and test portable admission/keepalive/dimension/forced-input decisions.

## Final verification
- [x] Run focused Core/server/browser suites including remote-video-stats; native Mac build/seven existing plus cursor self-test, Windows cross-build and portable C++ self-tests.
- [x] Focused strict types, isolated Core/server/browser/WebApp builds, Node22 composition; protocol backward compatibility and resize/ACK/scroll regressions.
- [x] Review only owned delta, save evidence/hashes, capture reusable findings to wiki; suggest docs sync without editing project docs.

## Completion evidence

- All four approved items are implemented across Core, browser/server, Mac/Windows native adapters and the Electron producer path.
- 36 files / 346 tests pass; eight Mac self-tests pass; Windows x64 cross-build and portable C++ algorithm tests pass; focused strict types and isolated Core/server/browser/WebApp builds pass.
- Node22 real helper IPC validates the versioned size capability, caps and restore/rejection paths without screen capture.
- The full WebApp check has the same six pre-existing errors after normalizing working-directory paths. One initial native admission self-test timeout was followed by successful current/previous comparison and full eight-test rerun; cause is unproven and retained in evidence.
- Actual display/iPhone testing remains explicitly deferred by the user; no Windows native runtime is available. No production deployment, restart, install, commit or push.
- Evidence: /Users/caoqu/Documents/Codex/2026-11-10/remote-receiver-optimization-verification/manifest.json.
