# Original quality encoder switching fix

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix the reproduced original-quality transition stall and verify actual frames after repeated smooth/HD/original switches.
**Architecture:** Keep capture, control and latest-frame admission on main. Inject an asynchronous compression port whose implementation serializes all VideoToolbox calls off main, invalidates obsolete sessions without synchronously draining obsolete frames, and requests hardware low-latency operation for compatible High profile. Generation checks discard late callbacks; bounded pending frames and a 3s deadline preserve responsive control on driver failure.
**Tech Stack:** Swift 5, ScreenCaptureKit, VideoToolbox, CoreMedia, Node 22, werift, Chromium via ego-browser.

## Constraints

- Preserve current dirty checkout. CLAUDE.md applies; docs/code-standards.md absent. No project docs edits, unrelated-service restart, Git push, or subagents. The later request to use the existing 100:3000/web address authorizes updating only its native helper; the previous installed bundle is backed up.
- No dropping true original-resolution acceptance to a smaller size. High and Baseline remain supported. Never run VT encode/property/teardown on main.
- Latest held frame <=1 and pending submissions <=2. Reset/stop invalidates generation before asynchronous disposal; old callback must never emit current output.
- Real capture uses an isolated built app and private sockets; authorization only through macOS normal prompts. Existing installed helper remains untouched.

## Implementation

- [x] Add `RemoteVideoCompressionPort.submit(pixel:timestamp:settings:forceKeyframe:submitted:completed:)` and `invalidate()` in `service/VideoCompression.swift`. Implement a serial worker, session identity by dimensions/profile, settings diff, hardware selection, and High low-latency rate control. Deliver callbacks to main in submission-before-completion order. Discard obsolete sessions without `CompleteFrames`.
- [x] Update `RemoteVideoEncoder` facade to reserve bounded jobs, inject compression port, gate callbacks by generation, and report stalled outstanding jobs at 3s without blocking control. Preserve compound onSubmitted ordering and monotonic timestamps.
- [x] Wire native build source list, facade deterministic self-test (slow/blocked port, reset/revoke, latest frame, bounds), and a separate real High/Baseline resolution-transition self-test. Keep original existing capture/cursor/compound checks.
- [x] Build isolated app, verify signature and native tests. Re-run focused server/core regression.
- [x] Inspect actual permission state; run real private capture/video chain with repeated 1280/2560/native-edge switches and concurrent status probes. Then verify browser decoded size and playback, using ego-browser. If privileges changed, ask only for missing permission.
- [x] Save reproducible evidence and final wiki capture. Document actual pass/fail and remaining environment boundary.

## Final Unit Test Verification

- [x] Main agent runs native admission/transition self-tests and affected remote-control Vitest suite after edits; fix failures, then perform real capture/browser switching acceptance. A connected peer or successful command alone does not count as a new decoded frame.

## Existing 100 address verification

- [x] Preserve :3000 and other running Agent tasks; update only the native helper through its normal installer to the exact tested preview.71 bundle, signature/fingerprint checked, old installed app retained in evidence.
- [x] Enable sharing and read back screen/accessibility=true, locked=false; no reauthorization needed.
- [x] Test 5 additional quality switches through http://100.121.10.115:3000/web with actual new decoded/presented frames (two 3440x1440 originals).
- [x] Save candidate pair evidence: same-Mac browser selected remote 10.22.34.159 / UDP / RTT 1ms. This is not WAN acceptance. Close own viewer to keep phone single-viewer path.
- [x] User explicitly chose computer-operated testing. Complete the existing 100 URL desktop acceptance and disclose that same-host media is not a WAN acceptance; no phone action remains required for this scope.

## Computer-operated acceptance follow-up

- [x] Record old runtime baseline: 14 switches and 6/6 clicks; median visible feedback 724.95ms, native arrival 35.36ms.
- [x] Build latest WebApp and Next with Node 22, retain rollback outputs, restart only :3000 and verify external Codex session timestamps continue. Fresh High/TWCC/receiver/protection/reliable-input paths appear in actual logs.
- [x] Repeat identical 14-switch/6-click script: all switches and clicks pass; median visible feedback 314.00ms, native arrival 13.43ms. Same-host sample, not a WAN or per-optimization benchmark.
- [x] Fix keyboard proxy selection buffer reset (presentation only), pass 55 focused tests, full WebApp typecheck and build. Verify 4 complete text values and 3 consecutive select-all replacements through the real browser/native app; fixture has standard Edit menu and current coordinates.
- [x] Verify final original 3440x1440, 3/3 additional clicks, inspect native frame text; close own browser TaskSpace and native QA app, leave shared service enabled.
