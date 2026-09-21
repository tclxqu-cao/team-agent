# Remote Desktop Media Optimization Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver adaptive, observable, lower-overhead WebRTC remote desktop video and restart the affected AgentRoam services.

**Architecture:** Preserve ScreenCaptureKit, VideoToolbox, werift and browser WebRTC decoding. Replace Base64 video events with a dedicated binary helper socket, feed browser/RTCP telemetry into a bounded adaptive controller, and make TURN plus transport diagnostics configurable.

**Tech Stack:** Swift 5, ScreenCaptureKit, VideoToolbox, Node.js 22, werift, React 18, TypeScript, Vitest, launchd.

## Global Constraints

- Preserve all existing uncommitted live-view, on-demand capture, helper shutdown, and ws-server changes.
- Do not store TURN credentials in source, logs, status payloads, or tests.
- Keep H.264 Baseline as the compatibility codec; browser playback remains a WebRTC `<video>` track.
- Explicit quality is the resolution/bitrate ceiling; adaptation must not silently reduce selected resolution.
- JPEG remains a bounded fallback and must be distinguishable from healthy WebRTC video.

---

### Task 1: Binary Native Video Channel

**Files:**
- Modify: `packages/server/lib/remote-control/helper-manager.mjs`
- Modify: `packages/server/lib/remote-control/helper-manager.test.ts`
- Modify: `packages/server/native/remote-helper/main.swift`
- Modify: `packages/server/native/remote-helper/service/VideoEncoder.swift`

**Interfaces:**
- Consumes: existing JSON control socket and `RemoteHelper.onVideo(listener)`.
- Produces: `encodeVideoFrame`/`decodeVideoFrames` binary framing and video events shaped as `{ timestamp, nals: Buffer[] }`.

- [ ] **Step 1: Define and test the binary frame contract**

Use a four-byte big-endian payload length followed by version/flags, float64 timestamp, NAL count, and repeated uint32 length plus raw NAL bytes. Reject payloads above 8 MiB, invalid versions, truncated NALs, and trailing bytes.

- [ ] **Step 2: Add a dedicated private Unix video socket**

Create it beside `bridge.sock`, accept only the first connection, and pass both socket paths to the native helper. Keep JSON command parsing on the control socket.

- [ ] **Step 3: Emit encoded NALs as binary Swift frames**

Connect the helper to the second socket and write serialized access units directly from the encoder callback without Base64 or JSON.

- [ ] **Step 4: Preserve teardown and retry behavior**

Close both sockets and servers during cancellation, idle shutdown, restart, and process exit without affecting the current graceful `quit` contract.

### Task 2: Adaptive H.264 Encoder

**Files:**
- Create: `packages/server/lib/remote-control/video-adaptation.mjs`
- Create: `packages/server/lib/remote-control/video-adaptation.test.ts`
- Modify: `packages/server/lib/remote-control/webrtc-video.mjs`
- Modify: `packages/server/lib/remote-control/webrtc-video.test.ts`
- Modify: `packages/server/native/remote-helper/main.swift`
- Modify: `packages/server/native/remote-helper/service/VideoEncoder.swift`

**Interfaces:**
- Consumes: browser `stats` signals, werift sender stats, and explicit `smooth|hd|original` ceiling.
- Produces: `{ bitRate, maxFps, reason }` tuning commands through helper operation `video-tuning`.

- [ ] **Step 1: Implement a pure bounded adaptation controller**

Reduce bitrate on loss above 5%, RTT above 250 ms, decoder drops, or measured throughput pressure; reduce FPS after repeated congestion. Increase only after three healthy samples. Clamp every value to the selected profile.

- [ ] **Step 2: Apply tuning without restarting capture**

Update VideoToolbox average bitrate/data-rate limits and skip frames according to `maxFps`. Capture at up to 30 FPS and keep PLI-triggered keyframes independent of frame throttling.

- [ ] **Step 3: Feed RTCP and browser telemetry into adaptation**

Read sender stats after the connection is active, accept validated browser stats, and serialize helper tuning commands so rapid samples cannot overlap.

### Task 3: TURN And WebRTC Diagnostics

**Files:**
- Create: `packages/server/lib/remote-control/ice-config.mjs`
- Create: `packages/server/lib/remote-control/ice-config.test.ts`
- Modify: `packages/server/lib/remote-control/webrtc-video.mjs`
- Modify: `packages/core/src/domain/live-view/live-view-registry.ts`
- Modify: `packages/core/src/domain/live-view/live-view-registry.test.ts`
- Create: `packages/desktop/renderer/components/remote-video-stats.ts`
- Create: `packages/desktop/renderer/components/remote-video-stats.test.ts`
- Modify: `packages/desktop/renderer/components/BrowserLivePanel.tsx`
- Modify: `packages/desktop/assets/webrtc-live.html`

**Interfaces:**
- Consumes: optional `AGENT_REMOTE_TURN_*` environment and browser `RTCStatsReport`.
- Produces: validated ICE server configuration, bounded `stats` signals, and a compact media diagnostic string.

- [ ] **Step 1: Parse ICE environment safely**

Always include the existing Google STUN server. Add TURN only when URLs, username and credential are all present; redact secrets from diagnostics.

- [ ] **Step 2: Extend signaling validation**

Allow `stats` with finite bounded numeric fields and `offer.iceServers` with valid URL-only STUN entries or credentialed TURN entries. Keep the 64 KiB signaling limit.

- [ ] **Step 3: Collect and normalize browser receive stats**

Poll once per second while connected, calculate bitrate and loss deltas, identify selected candidate protocol/type, and send only the bounded normalized sample.

- [ ] **Step 4: Render transport state and explicit fallback**

Show codec, dimensions/FPS, RTT, and direct/relay state in the existing control cue; show `JPEG 兜底` whenever the video track is not live but JPEG frames are present.

- [ ] **Step 5: Optimize the Electron capture hint**

Use `contentHint="detail"` for desktop capture and keep native-resolution, maintain-resolution behavior.

### Task 4: Build, Restart, And Runtime Acceptance

**Files:**
- Modify only as required by failures found in verification.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: rebuilt helper/WebApp/server artifacts and stable restarted services.

- [ ] **Step 1: Run focused tests and compile the helper**

Run the affected Vitest files, Swift helper build, quality self-test, core build, WebApp build, and Node 22 server build.

- [ ] **Step 2: Inspect active sessions and service ownership**

Check `/api/sessions`, launchd jobs, port 3000 listeners, established connections, and shadow processes before restart.

- [ ] **Step 3: Back up production artifacts and restart**

Move `.next` to a timestamped rollback directory, build with Node 22 and safe-delete disabled, restart the existing launchd job, and restart the remote-desktop service only after confirming it has no active viewer.

- [ ] **Step 4: Verify runtime behavior**

Prove stable PID/listener, `/web`, `/app/`, runtime health and sessions; verify the packaged helper identity, negotiate a local WebRTC session, inspect stats/selected candidate, and confirm forced WebRTC failure reveals JPEG fallback.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/core/src/domain/live-view/live-view-registry.test.ts packages/server/lib/remote-control/helper-manager.test.ts packages/server/lib/remote-control/webrtc-video.test.ts packages/server/lib/remote-control/video-adaptation.test.ts packages/server/lib/remote-control/ice-config.test.ts packages/desktop/renderer/components/remote-video-stats.test.ts
```

Expected: all tests pass. Fix implementation or tests and rerun until green, then run builds and runtime acceptance.
