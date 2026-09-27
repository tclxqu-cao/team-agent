# Remote Desktop Interaction FPS Recovery Design

- Date: 2026-09-27
- Status: approved
- Baseline: current `main`
- Related: `2026-09-21-remote-video-ddd-adaptation-design.md`

## Problem

The CLI-owned native remote desktop stream can remain at 5-7 FPS after the
user starts interacting, even on a local P2P connection with 1-2 ms RTT and
10-13 Mbps receive bitrate. The content policy intentionally lowers an idle
desktop to 5 FPS after three seconds, but recovery depends on the next
ScreenCaptureKit activity samples and the two-second adaptation timer. That
makes visible input feedback less responsive than the former JPEG path, which
woke capture immediately after input.

The media telemetry used by the policy is not persisted. Browser receiver
stats exist only in the control bar, helper encoder stats stay in process, and
the installed helper writes stdout and stderr to `/dev/null`. Existing service
logs therefore cannot explain a reported quality regression after the fact.

## Decision

Keep the adaptive WebRTC architecture and make interaction an explicit media
signal:

- Raise the idle floor from 5 FPS to 15 FPS.
- Add an interaction transition to `RemoteVideoPolicy` that immediately
  restores the activity target to 30 FPS and clears idle hysteresis.
- Invoke that transition whenever an accepted remote pointer, wheel, key, or
  text input enters the CLI remote-control path.
- Apply the resulting encoder decision asynchronously. Input dispatch must not
  wait for VideoToolbox tuning and must preserve current ordering and error
  behavior.
- Keep existing network and encoder pressure limits. Interaction restores the
  activity target, but pressure may still cap the effective rate at 15 or 5 FPS
  when the encoder or transport is unhealthy.

This preserves bandwidth and thermal adaptation while removing the avoidable
idle recovery delay.

## Logging

The server remote-video coordinator will emit structured media observations
through the existing global logger. A record contains only operational
telemetry:

- session transition or decision reason;
- content activity and confidence;
- target bitrate and FPS;
- RTT, loss, available bitrate, and transport dropped frames;
- encoder pending frames, encode latency, dropped frames, and sequence.

Logs must not include SDP, ICE addresses, TURN credentials, desktop pixels,
input text, or authentication data. Periodic records are emitted only when the
normalized decision or material observation changes; explicit interaction
wake events are emitted once per transition, preventing a mouse-move stream
from flooding the daily NDJSON file.

## Components

`RemoteVideoPolicy` owns the idle floor and interaction transition. It remains
framework-independent and returns an ordinary `RemoteVideoDecision`.

`RemoteVideoSession` exposes a non-blocking interaction method, applies the
decision through the existing coalesced tuning chain, and owns media telemetry
logging because it already combines transport, encoder, and policy data.

`RemoteAuthorization` calls the interaction method before forwarding accepted
remote input to the helper. It does not add media policy logic of its own.

## Failure Handling

- Encoder tuning failure remains best effort and must not fail remote input.
- Missing encoder or network telemetry produces a partial log record.
- Repeated identical observations and repeated input while already at the
  interaction target do not create duplicate log records.
- A subsequent pressure observation can lower FPS again using the existing
  hysteresis.

## Verification

- Policy tests prove idle settles at 15 FPS, interaction immediately requests
  30 FPS, and encoder pressure can still cap the result.
- Session tests prove interaction tuning is non-blocking, coalesced, and logged
  without sensitive signaling or input content.
- Remote authorization tests prove pointer, wheel, key, and text input wake the
  media session without changing input dispatch results.
- Run the focused Core and Server tests, Core build, and Server type/build
  checks required by the touched packages.
- Runtime acceptance uses the real `:3000` WebApp: after at least three idle
  seconds, trigger input and verify the displayed receiver FPS recovers toward
  30 without waiting for multiple adaptation intervals; verify the daily
  server NDJSON log contains the corresponding sanitized decision.
