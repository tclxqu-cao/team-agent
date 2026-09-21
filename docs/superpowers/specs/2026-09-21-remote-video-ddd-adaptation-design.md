# Remote Video DDD Adaptation Design

## Goal

Add content-aware frame rate, encoder queue feedback, H.264 High Profile with automatic Baseline fallback, and hardware decoder diagnostics without coupling the two desktop capture implementations.

The CLI and Electron paths share one framework-independent media policy. Each path keeps its own infrastructure adapter:

```text
CLI producer
  ScreenCaptureKit -> VideoToolbox -> binary IPC -> werift -> browser <video>

Electron producer
  getDisplayMedia -> Chromium/libwebrtc -> browser <video>
```

The work also corrects layering introduced by the previous media optimization. Binary IPC, TURN configuration, JPEG fallback, display selection, ownership, and control behavior stay intact.

## Current Problems

The existing implementation has useful behavior but mixes responsibilities:

- `video-adaptation.mjs` contains a reusable media policy inside server infrastructure.
- `RemoteWebrtcVideo` owns application orchestration, werift negotiation, H.264 RTP packetization, sender statistics, policy state, and native helper tuning.
- `LiveViewRegistry` validates SDP, ICE, TURN, and browser statistics even though its domain responsibility is live-session ownership and relay authorization.
- Receiver telemetry shapes are repeated in core, server, and renderer.
- The native helper exposes bitrate and FPS tuning but not encoder backlog, latency, drops, or codec profile failures.
- The Electron producer sets a fixed 20 Mbps ceiling and has no shared adaptation loop.

Moving the current classes without changing these dependencies would not fix the layering problem.

## Boundary Model

### Domain

`packages/core/src/domain/live-view/` owns media concepts and decisions. It must not import WebRTC, Electron, ScreenCaptureKit, VideoToolbox, Node sockets, or werift types.

Add:

- `remote-video-types.ts`: value types and port-neutral contracts.
- `remote-video-policy.ts`: the stateful adaptation policy and hysteresis.
- focused tests beside the policy.

The domain owns:

- the quality ceiling selected by the user;
- normalized content activity;
- normalized network and encoder pressure;
- adapter capability declarations;
- codec preference and fallback state;
- the resulting bitrate, FPS, resolution policy, and codec decision.

The existing `LiveViewFramePacer` remains the JPEG/CDP frame pacer. It is not reused for H.264 because its 2-10 FPS acknowledgement loop and semantics are different.

### Application

An application coordinator owns one producer media session. It receives normalized observations, asks `RemoteVideoPolicy` for a decision, and applies that decision through injected ports.

The coordinator owns:

- start, stop, pause, resume, and quality changes;
- serialized tuning updates;
- telemetry sampling cadence;
- codec negotiation attempts and one automatic High-to-Baseline retry;
- connection and first-frame timeouts;
- lifecycle cleanup and stale-generation rejection.

It depends on interfaces, not werift, VideoToolbox, or browser globals:

```ts
interface RemoteVideoEncoderPort {
  capabilities(): RemoteVideoAdapterCapabilities;
  start(config: RemoteVideoEncoderConfig): Promise<void>;
  apply(decision: RemoteVideoDecision): Promise<void>;
  requestKeyframe(): Promise<void>;
  snapshot(): Promise<EncoderTelemetry | null>;
  stop(): Promise<void>;
}

interface RemoteVideoTransportPort {
  negotiate(preferences: CodecPreference[]): Promise<NegotiatedCodec>;
  sendAccessUnit?(frame: EncodedAccessUnit): void;
  snapshot(): Promise<NetworkTelemetry | null>;
  stop(): Promise<void>;
}
```

The concrete server coordinator lives under `packages/server/lib/remote-control/application/`. The Electron coordinator lives in the desktop main process and imports the same domain policy from `@agent/core`.

### Infrastructure

Server infrastructure is split into adapters under `packages/server/lib/remote-control/infrastructure/`:

- a native helper encoder adapter for control commands, binary frames, capabilities, and encoder telemetry;
- a werift transport adapter for offer/answer, ICE, RTP packetization, RTCP feedback, and sender network telemetry;
- a signal parser at the WebSocket boundary for bounded SDP, ICE, TURN, telemetry, and codec-capability DTOs.

Desktop infrastructure remains browser-specific:

- the hidden capture page owns `getDisplayMedia`, transceivers, codec preferences, `applyConstraints`, `setParameters`, and outgoing `RTCStatsReport` parsing;
- `WebrtcLive` bridges normalized observations and decisions between the hidden page and the desktop application coordinator;
- the browser adapter declares unsupported capabilities instead of fabricating queue data or explicit encoder control.

Renderer infrastructure parses receiver `RTCStatsReport` values and presents diagnostics. Shared contracts are imported from `@agent/core` with `import type`; browser-specific stats objects do not enter the domain.

## Shared Contracts

The domain types use bounded, normalized values so both adapters can report evidence without exposing framework DTOs.

```ts
type RemoteVideoQuality = "smooth" | "hd" | "original";
type ContentActivity = "idle" | "interactive" | "motion";
type H264Profile = "high" | "baseline";

interface ContentActivitySample {
  activity: ContentActivity;
  confidence: number; // 0..1
  observedAt: number;
}

interface NetworkTelemetry {
  lossRate?: number;
  rttMs?: number;
  availableOutgoingBitrate?: number;
  droppedFrames?: number;
}

interface EncoderTelemetry {
  pendingFrames?: number;
  encodeLatencyMs?: number;
  droppedFrames?: number;
  sampledAt: number;
}

interface RemoteVideoAdapterCapabilities {
  dynamicBitrate: boolean;
  dynamicFrameRate: boolean;
  encoderQueueTelemetry: boolean;
  explicitH264Profile: boolean;
  codecPreferences: readonly H264Profile[];
}

interface RemoteVideoDecision {
  quality: RemoteVideoQuality;
  maxBitrate: number;
  maxFps: number;
  maintainResolution: true;
  preferredCodec: H264Profile;
  reason: string;
}
```

Unknown observations stay `undefined`; zero is a real measurement. Adapters must not convert absent browser metrics into zero pressure.

## Content-Aware Frame Rate

Adapters normalize their own evidence:

- The native adapter uses ScreenCaptureKit frame status, dirty-region coverage when available, and complete-frame cadence. It never passes `SCStreamFrameInfo` values into core.
- The browser adapter uses outgoing encoded-frame and byte deltas, track state, and sender cadence. It never passes raw `RTCStatsReport` rows into core.

The first implementation uses three targets within the chosen quality ceiling:

| Activity | Target FPS | Intent |
| --- | ---: | --- |
| idle | 5 | Static text remains sharp while bandwidth and encode work fall sharply. |
| interactive | 15 | Typing, menus, and ordinary UI changes stay responsive. |
| motion | 30 | Scrolling, dragging, animation, and video receive full cadence. |

The policy raises FPS quickly and lowers it slowly:

- two consecutive confident motion samples may raise to 30 FPS;
- an interactive sample raises an idle stream immediately to at least 15 FPS;
- idle must remain confident for at least three seconds before lowering to 5 FPS;
- weak or missing activity evidence keeps the current level;
- congestion or encoder pressure may lower the target sooner, but never changes resolution automatically.

Resolution remains controlled only by `smooth`, `hd`, and `original`. This preserves desktop text and avoids a feedback loop in which lower resolution makes content classification cheaper but less readable.

## Encoder Queue Feedback

The VideoToolbox adapter records:

- pending encode submissions;
- encode completion latency using the submission timestamp carried in the callback context;
- frames rejected before submission by FPS pacing;
- frames dropped or failed by `VTCompressionSessionEncodeFrame` and the output callback;
- a monotonic snapshot sequence so consumers can calculate deltas safely.

Pending count increments immediately before a successful submission and decrements exactly once on callback or synchronous submission failure. Reset and stop clear the counters associated with the old compression-session generation so late callbacks cannot corrupt a new session.

Queue pressure has explicit thresholds:

- `pendingFrames >= 3`, sustained encode latency above two target frame intervals, or new encoder drops marks pressure;
- pressure lowers FPS before lowering bitrate because fewer source frames directly relieve the encoder;
- severe network congestion may still lower bitrate first;
- recovery requires three healthy samples and increases one FPS step at a time.

The helper exposes the latest snapshot through the control channel. Binary IPC remains video-data only. The browser adapter reports `encoderQueueTelemetry: false` because Chromium does not expose a reliable pending encoder queue. It may report available encode-time and dropped-frame metrics as general encoder pressure, but the policy must not label them as queue depth.

## H.264 High Profile And Fallback

Codec selection is capability-driven and per session:

1. The receiver reports bounded H.264 codec capabilities from `RTCRtpReceiver.getCapabilities("video")`, including `sdpFmtpLine` values when exposed.
2. The producer adapter reports whether it can explicitly select High and Baseline.
3. The policy orders the intersection as `high`, then `baseline`. If High support is not proven on both sides, Baseline is selected directly.
4. The transport negotiates only profiles supported by both endpoints and reports the selected profile back to the coordinator.
5. The encoder starts with that exact profile. RTP payload metadata and the VideoToolbox bitstream profile must agree.

For the native path, the helper maps `high` and `baseline` to the corresponding VideoToolbox profile-level constants and checks every setup call. A failed High property assignment, session preparation, negotiation, or first-frame deadline triggers one automatic Baseline restart.

For the Electron path, the browser adapter orders supported H.264 codecs through `RTCRtpTransceiver.setCodecPreferences`. Chromium remains responsible for the encoder. If High negotiation or first-frame delivery fails, the coordinator recreates the peer connection with Baseline-only H.264 preferences.

Fallback rules:

- only one High-to-Baseline retry is allowed per session generation;
- the retry remains in `connecting` state and does not flash a terminal failure to the user;
- SDP/ICE state and encoder resources from the failed attempt are fully closed before retry;
- Baseline failure follows the existing WebRTC failure path and leaves JPEG fallback visible;
- the diagnostic state records selected profile and a bounded fallback reason.

## Receiver And Hardware Decoder Diagnostics

Both producer paths use the same receiver component, so decoder diagnostics are shared.

The receiver parser adds these fields to the shared sample:

```ts
interface DecoderDiagnostics {
  implementation?: string;
  powerEfficient?: boolean;
  acceleration: "hardware" | "software" | "unknown";
}
```

Rules:

- preserve a bounded raw `decoderImplementation` string for diagnosis;
- classify `hardware` only when a reliable browser boolean such as `powerEfficientDecoder === true` is present;
- classify `software` only when the same reliable signal is explicitly false;
- otherwise report `unknown`;
- never infer hardware acceleration from implementation-name substrings;
- absence of a field is not an error because browser support varies.

The compact status label continues to show route, codec, resolution/FPS, bitrate, and RTT. A secondary diagnostic line may show the raw decoder implementation plus `hardware`, `software`, or `unknown`. Existing WebRTC/P2P, TURN relay, and JPEG fallback labels remain unchanged.

## Signaling And Registry Boundaries

Raw WebRTC DTO validation moves out of `LiveViewRegistry` to the server WebSocket boundary. The parser enforces existing size limits and validates new capability, telemetry, decoder, and fallback fields before converting them to typed media messages.

`LiveViewRegistry` keeps only domain invariants:

- producer and viewer session identity;
- controller ownership and read-only enforcement;
- whether a quality change is allowed;
- which authorized peer receives an already-validated media message;
- caching and broadcasting the latest semantic quality state.

It must not parse SDP, inspect ICE URLs, understand candidate types, or know the shape of an `RTCStatsReport`. Infrastructure relay clients may still serialize the typed media message as JSON over the existing WebSocket RPC.

## Data Flow

### CLI path

```text
ScreenCaptureKit evidence ----> native activity normalizer ---+
VideoToolbox snapshot --------> native encoder adapter -------+--> application coordinator
werift/RTCP stats ------------> werift transport adapter -----+           |
                                                                          v
                                                               RemoteVideoPolicy
                                                                          |
                                     +------------------------------------+
                                     v
                          helper tuning/profile command
                                     |
                     binary H.264 access units -> RTP/SRTP -> receiver
```

### Electron path

```text
getDisplayMedia track/outbound stats -> browser sender adapter --+
receiver/network telemetry --------------------------------------+--> desktop coordinator
                                                                       |
                                                                       v
                                                            RemoteVideoPolicy
                                                                       |
                                  applyConstraints/setParameters/codec preferences
                                                                       |
                                                             Chromium WebRTC sender
```

The policy is shared. Capture, encode, transport, and raw telemetry parsing are not.

## Error And Concurrency Behavior

- All asynchronous observations and callbacks carry a session generation; stale generations are ignored.
- Tuning commands are serialized and coalesced so an older slow command cannot overwrite a newer decision.
- Unsupported adapter fields are capability-gated and omitted.
- A telemetry parse failure drops only that sample.
- Encoder telemetry failure keeps the stream running with network and activity adaptation.
- Helper or transport failure stops its session resources and uses the existing JPEG fallback.
- Pause stops adaptation timers and video writes; resume requests a keyframe and applies the latest decision.
- Quality or display changes preserve ownership and create a new encoder generation where dimensions or codec state require it.
- Static ScreenCaptureKit output is healthy. Lack of changed frames triggers a keyframe probe, not an immediate WebRTC failure.

## Migration Sequence

1. Add domain contracts and policy tests in `@agent/core`.
2. Add server signal parsing at the WebSocket boundary and remove WebRTC DTO validation from `LiveViewRegistry`.
3. Extract werift transport/RTP logic and the native helper adapter from `RemoteWebrtcVideo`.
4. Replace `RemoteWebrtcVideo` with the server application coordinator and keep a compatibility export only if tests or callers still require the old import path.
5. Add native activity and encoder telemetry plus profile-selectable VideoToolbox startup.
6. Add the desktop coordinator and browser sender adapter without routing Electron capture through the native helper.
7. Extend receiver diagnostics and renderer display using shared types.
8. Remove the server-local `VideoAdaptation` after all consumers use the core policy.

Intermediate commits must keep one functional path at a time; the migration must not require both adapters to be complete before the existing remote desktop can run.

## Verification

### Domain tests

- quality ceilings remain stable and never auto-reduce resolution;
- activity hysteresis produces 5/15/30 FPS transitions;
- network congestion and encoder pressure have deterministic priority;
- missing telemetry does not become pressure;
- capability intersections choose High only when both sides prove support;
- one failed High attempt selects Baseline and cannot loop.

### Adapter and application tests

- native pending count and latency remain correct across success, synchronous failure, callback failure, reset, and late callbacks;
- helper stats snapshots and profile commands are bounded and generation-safe;
- werift advertises and packetizes the negotiated profile consistently;
- server tuning commands are serialized/coalesced;
- browser adapter maps decisions to `applyConstraints`, `setParameters`, and codec preferences only when supported;
- browser adapter declares queue telemetry unsupported;
- raw signaling validation rejects oversized or malformed SDP, ICE, capabilities, and telemetry before the registry;
- registry ownership tests remain independent from WebRTC DTO shapes;
- High failure retries Baseline without publishing a terminal state;
- Baseline failure preserves JPEG fallback.

### Receiver tests

- raw decoder implementation is bounded and preserved;
- true/false `powerEfficientDecoder` maps to hardware/software;
- missing or non-boolean evidence maps to unknown;
- decoder name substrings never determine acceleration;
- P2P, TURN, and JPEG labels remain correct.

### Build and runtime gates

- focused core, server, desktop-main, renderer, and native helper tests pass;
- `@agent/core`, server production, WebApp, desktop TypeScript, and Swift helper builds pass;
- native helper quality self-test covers both H.264 profiles where the machine supports them;
- real browser playback proves first High frame or the Baseline retry, correct selected-profile diagnostics, quality switching, static-to-motion FPS recovery, and JPEG fallback;
- runtime diagnostics show actual decoder evidence without claiming hardware when the browser does not expose it;
- TURN relay remains a credential-dependent acceptance item and must be reported separately when credentials are unavailable.

## Out Of Scope

- Replacing werift with native libwebrtc.
- Routing Electron `getDisplayMedia` through ScreenCaptureKit or VideoToolbox.
- HEVC or AV1 negotiation.
- Pixel-diff analysis in JavaScript.
- Automatic resolution changes below the user-selected quality ceiling.
- Changes to remote input, ownership, authorization, display selection, or JPEG encoding.
