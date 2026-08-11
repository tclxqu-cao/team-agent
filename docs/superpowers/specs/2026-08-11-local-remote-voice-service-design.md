# Local and Remote Voice Service Design

## Goal

Replace the desktop application's file-based macOS speech recognition path with a reusable low-latency voice service. The service must support local and remote deployment with the same protocol, continuous Chinese ASR, offline Chinese TTS, wake-word interaction, input dictation, multi-turn conversation, and immediate TTS barge-in.

## Scope

- Add an independent `packages/voice-service` package that owns sherpa-onnx ASR and TTS inference.
- Use `sherpa-onnx-node@1.13.4` exactly. Version 1.13.5 is excluded because its matching Darwin arm64 package is not published.
- Use `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` for streaming Chinese ASR.
- Use the sherpa-onnx `vits-melo-tts-zh_en` model behind a TTS provider interface.
- Keep Swift `AVAudioEngine` capture, microphone TCC attribution, VAD, voice processing, and barge-in detection.
- Preserve the existing renderer IPC contracts for wake, dictation, agent submission, and TTS lifecycle where possible.
- Do not bundle or commit model weights. Local development reads ignored model directories; packaged and remote deployments receive model paths through configuration.
- Retain `SFSpeechRecognizer` and macOS `say` as last-resort fallbacks.

## Non-Goals

- Training, fine-tuning, or converting model weights.
- A model download user interface.
- Redis-backed or horizontally distributed session state.
- Replacing the application's LLM or agent protocol.
- Shipping model weights before their redistribution licenses are confirmed.

## Architecture

`packages/voice-service` is a standalone Node service with no Electron dependency. It loads ASR once at process startup and lazily loads TTS on the first synthesis request. A desktop `VoiceServiceClient` connects either to a configured remote endpoint or to a localhost process launched by Electron. Both modes use the same WebSocket ASR protocol and HTTP TTS contract.

The Swift helper gains an external-ASR mode. In that mode it writes mono 16 kHz float32 little-endian PCM to stdout and writes line-oriented lifecycle/VAD controls to stderr. Electron forwards PCM to `VoiceServiceClient`; it does not run synchronous sherpa decoding on the main thread. Native recognition remains available as a separate fallback mode.

The desktop selects providers in this order:

1. Configured remote voice service.
2. Managed localhost voice service using local models.
3. Native macOS speech recognition and `say`.

Failover advances only after a connection or readiness failure. A phrase already accepted as `FINAL` is never resubmitted during failover.

## ASR Protocol

The service exposes `WS /v1/asr`. Text frames are JSON control or result events; binary frames are raw mono float32 little-endian PCM.

The client opens a socket and sends:

```json
{
  "type": "start",
  "sessionId": "voice-session-id",
  "generation": 7,
  "sampleRate": 16000,
  "mode": "wake"
}
```

`mode` is `wake`, `dictation`, or `barge-in`. The service replies with `ready`, then zero or more `partial` events and one `final` event per endpoint:

```json
{"type":"partial","sessionId":"voice-session-id","generation":7,"text":"你好小智"}
{"type":"final","sessionId":"voice-session-id","generation":7,"utteranceId":3,"text":"你好小智今天天气怎么样"}
```

Control messages are:

- `reset`: discard the current decoder stream and begin a new utterance within the same connection.
- `finish`: flush trailing samples, emit a final result if non-empty, and reset.
- `stop`: release the per-connection stream and close normally.

The server validates the first message, sample rate, frame ordering, frame size, and session identifiers. Protocol violations return a structured `error` and close the connection. ASR text removes invalid replacement characters and surrounding whitespace. Empty partials and finals are not emitted.

## TTS Protocol

The service exposes `POST /v1/tts`:

```json
{
  "sessionId": "voice-session-id",
  "generation": 12,
  "text": "这是本轮回答。",
  "voice": "default-zh-female",
  "speed": 1
}
```

The successful response is WAV audio and includes the request generation in a response header. The desktop streams the response into a cancellable playback process. Closing or aborting the HTTP request cancels unused synthesis output from the client's perspective. The service limits text length, validates speed, strips no semantic punctuation, and serializes local synthesis jobs because the selected TTS engine is synchronous.

The TTS provider boundary allows a future model replacement without changing desktop behavior. If VITS is unavailable, the client falls back to macOS `say` for that utterance.

## Conversation Flow

1. In hidden wake mode, Swift continuously captures audio and the service emits streaming hypotheses.
2. A wake match restores the window. Text after the wake word seeds the first command; a wake-only final rearms command capture.
3. A non-empty ASR final is sent once to the current AI session.
4. The AI response remains visible as it streams. At the existing response completion boundary, the final response text is submitted to TTS and played.
5. During voice-conversation TTS, Swift voice processing remains enabled. Sustained onset at the existing peak, RMS, and duration thresholds emits `BARGE_IN` immediately.
6. `BARGE_IN` aborts playback and the active TTS request, advances the TTS generation, and opens command capture without waiting for ASR text.
7. PCM from the same utterance continues to ASR. Its final text becomes the next AI turn.
8. Further turns do not require the wake word while the existing 90-second conversation window remains active.

Recognized user text is never spoken back. Only the AI response is synthesized.

## Generation and Stale Result Rules

Every ASR connection and TTS request carries a monotonically increasing generation. The desktop accepts a result only when both its session ID and generation match the current state. Restart, mode switch, provider failover, manual stop, and barge-in each invalidate the affected generation before terminating old work.

This prevents a late final from an old ASR connection from submitting a duplicate turn and prevents audio from an interrupted TTS request from playing after the user has started the next turn.

## Swift Audio Contract

- Output sample format: mono float32 little-endian PCM at 16,000 Hz.
- Convert from the input node's hardware format with `AVAudioConverter` inside the capture helper.
- stdout contains PCM only in external-ASR mode.
- stderr contains `READY`, `BARGE_IN`, `HB`, and `ERROR` lines.
- Keep the current normal speech threshold of 0.009.
- Keep barge-in onset peak 0.10, RMS 0.02, and sustained duration 0.25 seconds.
- After `BARGE_IN`, return to the normal threshold so the complete interruption is captured.
- External-ASR mode requires microphone permission only and must not request Speech authorization.

## Configuration and Models

Environment variables provide deploy-time configuration:

- `VOICE_SERVICE_URL`: remote base URL. When absent, Electron manages localhost.
- `VOICE_SERVICE_TOKEN`: optional Bearer token for remote HTTP and WebSocket requests.
- `VOICE_SERVICE_PORT`: localhost/server port, default `17863`.
- `VOICE_ASR_MODEL_DIR`: Zipformer model directory.
- `VOICE_TTS_MODEL_DIR`: Chinese VITS model directory.

Development also searches `packages/desktop/.agent-data/asr-models` and `.agent-data/tts-models`. The TTS directory name is `vits-melo-tts-zh_en`. A packaged application searches its user-data model directory. Model installation is explicit; recognition and synthesis never trigger an implicit download.

Remote mode requires TLS at the reverse proxy. The service itself supports loopback HTTP for local mode and token authentication when exposed beyond loopback.

## Lifecycle and Failure Handling

- Local Electron startup launches the voice service with `process.execPath` and `ELECTRON_RUN_AS_NODE=1`, then waits for `/health` readiness without blocking the main thread.
- `/health` reports process readiness and ASR/TTS model availability without exposing filesystem paths.
- ASR model load failure prevents ASR readiness and triggers provider fallback.
- TTS load failure does not disable ASR; only TTS falls back.
- Unexpected local service exit is restarted with bounded backoff while voice listening is desired.
- Remote disconnect invalidates its generation before selecting localhost.
- The desktop terminates its managed local process on app shutdown, but never terminates a configured remote service.
- No audio, transcript, token, or model path is logged by default. Development diagnostics may report timing and state transitions.

## Testing

Unit tests cover protocol parsing, configuration resolution, model file validation, generation rejection, endpoint reset, TTS request validation, and provider selection. Integration tests start the real service with controlled dependencies, send binary PCM, and assert observable WebSocket/HTTP behavior. Existing wake/dictation/barge-in state tests remain green and gain explicit stale-generation and second-turn cases.

Native verification compiles the Swift helper and exercises its external-ASR output contract. End-to-end manual verification uses the real model and microphone for:

1. Hidden wake and first command.
2. Input-box dictation.
3. AI response TTS.
4. Spoken barge-in during TTS.
5. Second and third commands without another wake word.
6. Remote-to-local and local-to-native fallback.

## Acceptance Criteria

- The ASR model loads once and stays resident across utterances and mode changes.
- First partials are delivered while the user is speaking; recognition does not wait for a CAF file or 0.8 seconds of post-speech silence.
- Wake, dictation, and same-session multi-turn commands each produce one final submission.
- User speech stops active TTS before transcription completes.
- Interrupted or stale TTS never resumes during the next turn.
- Both localhost and remote deployments pass the same protocol test suite.
- Missing remote service, ASR model, or TTS model degrades through the documented fallback chain without breaking text chat.
- Desktop TypeScript, Swift compilation, focused tests, full desktop tests, and real microphone validation pass before delivery.
