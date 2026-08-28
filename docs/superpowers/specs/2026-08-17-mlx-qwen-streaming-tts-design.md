# MLX Qwen Streaming TTS Design

## Goal

Replace the current whole-utterance Melo VITS synthesis and WAV playback path with a local, genuinely streaming Chinese TTS path on Apple Silicon.

The warm-path target is:

- first audible audio in 200-700 ms;
- PCM playback begins before the complete utterance is synthesized;
- keyboard input, microphone dictation, and detected barge-in stop both generation and playback immediately;
- the next assistant response uses a fresh generation and cannot resume stale audio;
- ASR, KWS, wake, dictation, and local/remote voice-service selection remain compatible.

## Selected Engine

Use `mlx-audio` with `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit`.

Reasons:

- Qwen3-TTS supports Mandarin and includes native Chinese voices.
- The MLX implementation is optimized for Apple Silicon and incrementally decodes speech tokens into PCM.
- The runtime is MIT licensed and the model is Apache-2.0 licensed.
- The 6-bit model is preferred over 4-bit because the total download only decreases by about 140 MB at 4-bit while speech quality may regress.
- The model download is about 1.83 GB. Expected runtime memory is several GB, which is acceptable on the target 36 GB M3 Pro.

The implementation must not use the upstream Qwen Python convenience API as the streaming layer because its public high-level generation API currently returns complete utterances. It must use MLX-Audio's incremental decoder path.

## Architecture

The existing Node voice service remains the public gateway and continues to own ASR and KWS. A persistent Python MLX worker is added for TTS only.

```text
Electron renderer
  -> preload IPC
  -> Electron main VoiceServiceClient
  -> voice-service streaming TTS WebSocket
  -> persistent MLX Python worker
  -> Qwen3-TTS incremental decoder
  -> framed mono PCM
  -> AudioWorklet bounded ring buffer
  -> macOS audio output
```

The MLX worker loads the model once during voice-service startup. Model loading is part of service readiness; synthesis requests never load the model synchronously.

The existing `POST /v1/tts` complete-WAV endpoint remains temporarily available for compatibility and focused regression tests. Desktop playback switches to the streaming endpoint and no longer creates temporary WAV files or starts `afplay`.

## Streaming Protocol

Add `WS /v1/tts/stream` to the Node voice service.

The client opens one socket per synthesis generation and sends:

```json
{
  "type": "start",
  "sessionId": "session-id",
  "generation": 12,
  "text": "需要播报的中文内容",
  "voice": "Serena",
  "speed": 1
}
```

The server sends a metadata message before binary audio:

```json
{
  "type": "started",
  "sessionId": "session-id",
  "generation": 12,
  "sampleRate": 24000,
  "channels": 1,
  "sampleFormat": "s16le"
}
```

Each binary WebSocket message contains only interleaved signed 16-bit little-endian PCM for that generation. The stream ends with one of:

```json
{ "type": "finished", "generation": 12 }
{ "type": "cancelled", "generation": 12 }
{ "type": "error", "generation": 12, "message": "..." }
```

Generation values are mandatory on every control message. Unknown, stale, or duplicate generations are discarded.

## Worker Protocol

The Python worker communicates with the Node voice service through framed stdio and does not open another network port. Node sends newline-delimited JSON commands on stdin: `init`, `synthesize`, `cancel`, and `shutdown`. The worker sends stdout frames with a one-byte kind, a four-byte unsigned big-endian payload length, and the payload. Control payloads are UTF-8 JSON; audio payloads are raw `s16le` PCM. It emits metadata, PCM chunks, completion, and errors without writing audio files.

The worker has a dedicated stdin reader thread so `cancel` can set the active generation's cancellation event while inference is running. Synthesis runs on one worker thread. A blocked stdout write applies operating-system pipe backpressure without preventing the stdin reader from accepting cancellation.

The worker must:

- keep one loaded MLX model instance;
- use `stream=True` and a starting `streaming_interval` of 0.32 seconds;
- convert each MLX float waveform chunk to clipped `s16le` PCM;
- check cancellation between generated chunks;
- stop advancing the Python generator after cancellation;
- send logs to stderr only, never into the binary channel;
- expose ready and fatal-error states to the Node gateway.

Only one synthesis runs at a time initially. A new accepted generation cancels an older generation rather than waiting behind it. The old `TtsEngine.tail` serialization behavior is not carried into the streaming engine.

## Backpressure And Memory Bounds

Every queue is bounded:

- Node stops reading or forwarding worker audio when the client socket exceeds the configured buffered-byte limit.
- The worker-to-Node transport relies on a bounded pipe/socket and does not enqueue unbounded Python or JavaScript arrays.
- The renderer ring buffer holds at most 1.0 second of PCM.
- Playback starts after approximately 120-200 ms is buffered to avoid underruns without defeating the first-audio target.
- If the producer remains faster than the consumer and the hard limit is reached, generation is cancelled with an explicit overflow error rather than growing memory.

This design must not restore sherpa-onnx `onProgress`, whose unbounded native-to-JavaScript queue previously caused an OOM.

## Playback

Add an AudioWorklet PCM player in the renderer. Main forwards transferable `ArrayBuffer` chunks through preload IPC. The worklet writes them into a fixed-capacity ring buffer and continuously renders mono audio at the AudioContext sample rate, resampling from 24 kHz when required.

Playback state is explicit:

- `idle`: no active generation;
- `buffering`: generation accepted, waiting for minimum buffered audio;
- `playing`: worklet is consuming PCM;
- `draining`: synthesis finished and remaining PCM is playing;
- `stopped`: generation was cancelled and the buffer was flushed.

`tts:end` is emitted only when the current generation drains, is cancelled, or fails. Stale socket and worklet events cannot change current UI state.

## Interruption

All existing interruption sources use one stop operation:

- BARGE_IN from the microphone helper;
- keyboard submission;
- text changes that currently stop speech;
- dictation start;
- manual stop button;
- a newer assistant response.

Stopping performs these actions in order:

1. increment the desktop TTS generation;
2. abort or close the streaming request;
3. tell the worker to cancel the matching generation;
4. flush the AudioWorklet ring buffer immediately;
5. emit `tts:end` for the stopped current generation;
6. preserve the existing wake/barge-in state transition rules.

The microphone helper must enter barge-in mode before synthesis starts, as in the existing validated flow.

## Configuration And Model Management

Add configuration for:

- MLX Python executable;
- worker script path;
- local or Hugging Face model identifier;
- model cache directory;
- voice name, defaulting to `Serena`;
- streaming interval and playback buffer thresholds.

The model is downloaded by an explicit setup script or first-run model preparation step, not during the first spoken response. Health reports separate `ttsLoading`, `ttsReady`, and `ttsError` states.

There is no fallback to macOS `say` or browser `speechSynthesis`. If the configured model is unavailable, the UI reports the model error and wake listening resumes.

Remote voice services use the same public streaming protocol. A remote deployment can choose a different internal TTS provider later without changing Electron.

## Compatibility And Migration

- Existing ASR and KWS WebSocket contracts remain unchanged.
- Existing generation and session semantics remain unchanged.
- The complete-WAV TTS endpoint remains during migration but is no longer used by desktop playback.
- Melo model configuration remains readable for rollback during development, but strict model mode never silently switches engines.
- No generated model files or Python virtual environment contents are committed to Git.

## Verification

Automated coverage must include:

- protocol validation and authentication for streaming TTS;
- started, PCM, finished, cancelled, and error ordering;
- stale generation rejection;
- cancellation before first PCM and during playback;
- bounded queue overflow behavior;
- renderer ring-buffer enqueue, drain, flush, and underrun behavior;
- manual and automatic playback sharing one engine;
- barge-in stopping the old generation before the next response begins;
- existing ASR, KWS, dictation, and wake regression tests;
- desktop and voice-service TypeScript builds;
- Python worker syntax and focused worker tests;
- `git diff --check`.

Runtime verification on the target M3 Pro must record:

- cold model-load time;
- warm first PCM and first audible latency for an 8-character sentence;
- warm first PCM and first audible latency for the existing 95-character test text;
- peak physical footprint and idle physical footprint;
- no temporary WAV, `afplay`, `say`, or `speechSynthesis.speak` process/path;
- a real desktop playback that starts before synthesis completion;
- a barge-in or deterministic stop that silences buffered audio immediately and permits the next response to play;
- wake listener recovery after finish, cancellation, and synthesis error.

The target is accepted only if warm first audible latency is no more than 700 ms for both short and long text. If this target is missed, chunk interval, initial buffering, model quantization, and worker transport must be measured before changing engines again.

## Rollout

Implementation proceeds in three checkpoints:

1. standalone MLX worker POC with measured incremental PCM and memory;
2. voice-service streaming protocol plus cancellation and backpressure;
3. Electron AudioWorklet playback, interruption integration, and full desktop verification.

The branch is pushed only after all required automated checks pass and the target-machine runtime evidence is collected. This repository does not run `git-ai` for this work, per the project-specific user instruction.
