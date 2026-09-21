# Remote Desktop Media Optimization Design

## Goal

Reduce remote-desktop latency and bandwidth while preserving readable desktop text, browser/PWA playback, existing control semantics, multi-display switching, explicit quality selection, and JPEG fallback.

## Chosen Architecture

Keep WebRTC and the existing native capture/encode stack:

```text
ScreenCaptureKit
  -> VideoToolbox H.264 real-time encoder
  -> binary Unix-socket video channel
  -> werift RTP/SRTP sender
  -> browser RTCPeerConnection
  -> native <video> decode
```

The control socket remains newline-delimited JSON. Encoded H.264 access units move to a separate length-prefixed binary socket so video no longer pays Base64 expansion or JSON parsing costs. `werift` remains the WebRTC transport because the installed implementation already provides RTP history/NACK retransmission, receiver reports, RTT/loss stats, REMB and TWCC processing.

## Media Profiles

The user-facing quality names remain stable:

| Profile | Maximum edge | Maximum bitrate | Active FPS | Static/poor-network FPS |
| --- | ---: | ---: | ---: | ---: |
| smooth | 1280 | 2 Mbps | 30 | 5-15 |
| hd | 2560 | 8 Mbps | 30 | 5-20 |
| original | native | 20 Mbps | 30 | 5-30 |

An explicit quality choice is a ceiling, not a fixed transmission rate. Browser receive stats and sender RTCP stats drive an adaptive controller within the chosen ceiling. Sustained loss, RTT, dropped frames, or bandwidth pressure reduce bitrate first and FPS second. Sustained healthy samples increase conservatively. Resolution changes remain explicit through the existing quality selector so fine desktop text is not silently blurred.

VideoToolbox stays in real-time, no-frame-reordering H.264 Baseline mode for broad WebRTC compatibility. It receives live bitrate and FPS updates without restarting ScreenCaptureKit. Keyframes remain requestable through PLI and helper probes.

## Browser Playback And Diagnostics

The Web/PWA viewer continues attaching the remote MediaStream to `<video>`, allowing the browser to select its native decoder. Once per second it reads `RTCPeerConnection.getStats()` and derives:

- codec and decoder implementation;
- actual width, height, and frames per second;
- receive bitrate, packet loss, dropped frames, jitter, and RTT;
- selected candidate type and protocol (`host`, `srflx`, or `relay`).

The viewer sends a bounded `stats` WebRTC signal to the producer for adaptation and renders a compact connection diagnostic in the existing control cue. JPEG fallback is labeled explicitly instead of looking like a slow WebRTC stream.

## ICE And TURN

STUN remains the default. Optional TURN is supplied through environment variables and never committed with credentials:

- `AGENT_REMOTE_TURN_URLS`: comma-separated TURN URLs;
- `AGENT_REMOTE_TURN_USERNAME`;
- `AGENT_REMOTE_TURN_CREDENTIAL`.

The server validates the configuration, gives the offerer STUN plus TURN servers, and includes the same sanitized ICE configuration in the authenticated offer signal so the browser can create its peer consistently. Missing or incomplete TURN credentials fall back to STUN and surface a diagnostic warning without breaking local/LAN use.

## Failure And Compatibility Behavior

- The control channel continues working when the binary video socket is unavailable.
- A helper without the new video socket fails WebRTC video explicitly and leaves JPEG fallback available.
- Oversized or malformed binary video frames close only the video channel.
- WebRTC failure continues to reveal the last decoded JPEG frame.
- Quality switching, display switching, idle capture shutdown, lock/wake/unlock, and controller ownership retain their current contracts.
- The legacy Electron hidden-capture path changes its screen-content hint from `motion` to `detail`; its browser WebRTC transport remains otherwise compatible.

## Verification

Completion requires:

1. Unit tests for binary frame encoding/decoding, ICE configuration, adaptive decisions, signal validation, and browser stats normalization.
2. Real Swift helper compilation plus its quality self-test.
3. Focused core/server/WebApp tests and production builds.
4. Restart of the `:3000` service and remote-desktop service without interrupting a genuinely active session.
5. Runtime proof of stable listeners/routes, native helper availability, WebRTC negotiation, selected video transport, and JPEG fallback behavior.
