# Sherpa KWS Wake-Word Design

## Goal

Make the default `小智` wake word reliable without weakening ordinary ASR matching. A dedicated sherpa-onnx keyword spotter detects the wake phrase; the existing Zipformer recognizer continues to transcribe commands, dictation, continuous conversation, and TTS barge-in.

## Root Cause

The current `wake` mode sends all microphone PCM to the general-purpose `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` recognizer and matches its transcript against homophone variants. Real runtime evidence showed healthy microphone PCM and continuous ASR output, but `小智` was decoded as unrelated phrases such as `资金...`; even `你好小智，请打开窗口` played through the physical audio path decoded as `就到了`. Text aliases cannot safely recover these unconstrained errors without increasing false wakes.

## Architecture

Add the official Chinese KWS model `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` to the standalone `packages/voice-service` process. The model is small (approximately 12 MB encoder, or 4.6 MB int8 encoder) and is loaded once beside the existing ASR and TTS engines.

The provider order remains unchanged:

1. Configured remote voice service.
2. Managed localhost voice service.
3. Native macOS speech fallback.

The Swift helper remains responsible for TCC, microphone capture, 16 kHz mono float32 PCM conversion, VAD, voice processing, and barge-in onset. It does not load the KWS model.

## Wake Flow

1. The desktop opens `WS /v1/asr` with mode `wake`, the current `sessionId`, `generation`, and wake word.
2. When the wake word is the supported default `小智` and KWS is ready, the service creates a KWS stream instead of a general ASR stream.
3. PCM is decoded only by the keyword spotter until it detects `小智`.
4. The service emits a `keyword` event and atomically replaces the KWS stream with a fresh Zipformer ASR stream on the same WebSocket connection.
5. The desktop restores the window and starts command capture immediately. Subsequent PCM is transcribed by Zipformer into `partial` and `final` events.
6. After a non-empty command final is submitted, the desktop starts a new `wake` generation, returning the service to KWS detection.

The intended spoken interaction is `小智` followed by the command. A short natural pause is acceptable and avoids feeding the wake phrase into command transcription. The existing wake-only capture timeout remains the guard for users who wait before speaking the command.

## Other Modes

- `dictation` always uses Zipformer ASR and preserves `partial`, `final`, and `finished` behavior.
- `barge-in` always uses Zipformer ASR. Swift VAD still emits `BARGE_IN` before transcription completes, so TTS cancellation latency does not depend on KWS.
- During the 90-second voice-conversation window, follow-up utterances use Zipformer directly and do not require KWS.
- A non-default user-configured wake word uses the existing transcript/homophone matcher until a matching KWS token configuration is provided. The service reports whether KWS was selected in its `ready` event so the desktop can preserve this fallback explicitly.

## Protocol

Extend the ASR start control with optional `wakeWord`:

```json
{
  "type": "start",
  "sessionId": "voice-session-id",
  "generation": 9,
  "sampleRate": 16000,
  "mode": "wake",
  "wakeWord": "小智"
}
```

The `ready` event includes `strategy: "kws" | "asr"`. KWS detection emits:

```json
{
  "type": "keyword",
  "sessionId": "voice-session-id",
  "generation": 9,
  "keyword": "小智"
}
```

All events remain guarded by `sessionId + generation`. A late keyword from an old connection is ignored. `reset`, `finish`, and `stop` retain their existing meanings. A `finish` in KWS-only state still returns `finished` without fabricating text.

## Model and Keyword Files

- Model directory: `packages/desktop/.agent-data/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` in development, or `VOICE_KWS_MODEL_DIR` when configured.
- Required files: encoder, decoder, joiner, and `tokens.txt`.
- The default keyword token file contains the model's partial-pinyin tokenization for `小智` plus the original label, generated using sherpa-onnx `scripts/text2token.py` semantics.
- Model weights stay Git-ignored and are installed only by an explicit checksum-aware download script.
- Missing or invalid KWS assets do not take down ASR/TTS. `/health` reports `kws: false`, and `wake` falls back to transcript matching.

## Error and Lifecycle Handling

- KWS load errors are reported without exposing model paths through `/health`.
- A KWS decode error closes only the affected socket; desktop generation invalidation prevents stale events.
- On `keyword`, the old KWS stream is reset before the ASR stream becomes active, preventing duplicate keyword events.
- Restarting or switching modes closes both possible stream types.
- Remote authentication and TLS requirements remain unchanged.

## Testing

Automated tests cover:

- KWS model file discovery and missing-file errors.
- KWS configuration, thresholds, keyword file, and sherpa addon construction.
- PCM decoding that emits one `keyword` event and then routes later PCM to a fresh ASR stream.
- No ASR transcript before KWS detection in supported default-wake mode.
- `ready.strategy`, stale keyword rejection, stop/reset/finish lifecycle, custom-wake ASR fallback, and missing-KWS fallback.
- Existing dictation, multi-turn, TTS, and barge-in regressions.

Runtime validation uses, in order:

1. The official model test WAVs to prove the KWS engine and Node addon.
2. A generated or recorded `小智` WAV through the service protocol.
3. LaunchServices desktop startup with the physical microphone, hidden-window `小智` wake, command submission, AI response, and a second voice turn.
4. Negative listening during ordinary speech to check for obvious false wakes.

## Acceptance Criteria

- Saying `小智` while the window is hidden produces a current-generation `keyword` event and restores the window.
- The command spoken after wake is transcribed once and sent once.
- Ordinary speech observed during a bounded negative test does not wake the window.
- Dictation, continuous conversation, TTS, and spoken barge-in retain their existing behavior.
- Local and remote services use the same protocol and fallback behavior.
- Missing KWS assets degrade to the current ASR wake matcher rather than disabling voice input.
- Focused tests, voice-service build, desktop compile, Swift contract tests, and real runtime validation pass before delivery.
