# Remote feedback, buffer, protection and input implementation plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Complete the four approved optimizations for the existing browser remote desktop.

**Architecture:** Core owns feedback validity, playout targets, protection allocation and direct-input sequencing. Browser/werift adapters probe capabilities and serialize their native protocols. Existing authorization and reliable input routing remain authoritative.

**Tech Stack:** TypeScript, ESM, installed werift 0.24.4, browser WebRTC, Node 22.22.0 and Vitest.

## Global constraints

- Preserve dirty changes. CLAUDE.md requires DDD and ports; docs/code-standards.md is absent.
- The user approved all four items. No additional design approval, deployment, commit or native permission changes.
- No project docs writes. Plans and verification artifacts live outside docs.
- TWCC negotiates per peer; REMB remains the compatibility fallback. Sparse/application-limited traffic alone must not reduce frame rate.
- Playout writes require a real exposed receiver property and successful readback; unsupported browsers retain automatic buffering. Targets remain within 20–150 ms and restore on cleanup.
- Protection allocation uses bounded fresh counter deltas, not a recursively reduced encoder target. Video + patches + reserved repairs fit the original nominal media budget.
- Direct input initially covers hover moves only. Clicks, dragging, keys, wheel and probes retain reliable dispatch. A stream identifier, reliable-input fence and controller epoch reject reordered or revoked input.

### Task 1: Domain policies

**Files:** New Core live-view feedback/protection/playout/input-policy modules and tests; update exports/types/pacing/policy and registry.

- [x] Implement feedback classification from `sentBytes` delta with 100–3000 ms windows and at least 24 KiB traffic. Set `applicationLimited` using target utilization and queue pressure; expose congestion only with usable traffic evidence.
- [x] Implement `RemoteVideoProtectionPolicy.observe(sample, now)` and `allocation(totalBitRate)`; derive reserved bitrate from actual repaired-byte rate, adapt repair allowance within 2–30%, and decay on fresh healthy samples. Ignore stale/reset counters.
- [x] Implement `RemoteVideoPlayoutPolicy.observe(receiver, jitterMs, now)` with bounded targets, fast increase/slow decrease, and no feedback from hidden/stale/insufficient samples.
- [x] Implement `RemoteDirectInputPolicy.acceptReliable(stamp)` and `acceptMove(message)`; require increasing sequence, matching stream and last reliable barrier. Registry binds each stream to the authenticated controller epoch.

### Task 2: Server wiring

**Files:** werift transport/recovery, paced sender, remote video session, signal parser, RemoteAuthorization and webrtc-video composition.

- [x] Advertise transport-cc and matching extensions. Subscribe per sender to BWE events, validate negotiated capability, normalize through Core and clear stale estimates/listeners.
- [x] Track primary/recovery bytes and apply dynamic repair rate through the common pacer. Apply protection allocation before compound allocation and feed actual observations back periodically.
- [x] Create an optional unordered zero-retry input data channel. Bound and validate messages; use the input callback captured for that attempt. RemoteAuthorization registers the trusted controller context and routes accepted moves through its existing serial dispatch queue.
- [x] Extend telemetry validation/logging for measured buffer and feedback/protection fields.

### Task 3: Browser wiring

**Files:** remote-video-stats, new browser playout/input adapters and tests, BrowserLivePanel.

- [x] Compute jitter-buffer delay/target/minimum deltas using emitted counts and valid sample windows. Apply supported playout targets and report readback separately from measured delay.
- [x] Bind the input stream advertised by the authenticated offer. Send eligible hover moves through the channel; tag reliable fallback events with a sequence fence. Channel failure falls back to the existing request port.
- [x] Clear direct input and restore playout ownership when peers, sessions, visibility or control change. Preserve existing composer/toolbar behavior.

## Final unit test verification

- [x] Main agent: run affected Core, registry, server, transport, authorization and browser adapter tests; fix failures.
- [x] Use real local ICE/DTLS/SRTP/SCTP negotiation to verify transport-cc negotiation/fallback and direct channel traffic. Exercise stale controller/input barriers, malformed messages and backpressure.
- [x] Build Core declarations, WebApp bundle and no-emit types; inspect browser-safe imports and diff whitespace. Save exact results to `/Users/caoqu/Documents/Codex/2026-11-10/remote-feedback-buffer-budget-input-verification/` and capture verified conclusions to wiki.

## Final evidence

379 tests / 38 files passed on Node 22.22.0. Core bundle/declarations, WebApp no-emit and isolated Vite build passed. Real encrypted local UDP/SCTP tests covered TWCC including media-source zero, negotiated fallback, direct hover, controller revocation and the previous lost-fragment recovery. Test-viewer TWCC padding was normalized to valid RTCP and separately reproduced; this is documented in the report. No deployment or physical phone/Windows acceptance. Report: `/Users/caoqu/Documents/Codex/2026-11-10/remote-feedback-buffer-budget-input-verification/report.md`.
