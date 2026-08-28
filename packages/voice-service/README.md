# Voice Service

Standalone local or remote Chinese voice service for Customer Agent. It exposes streaming ASR and TTS over WebSocket while keeping sherpa-onnx and MLX inference outside Electron's main process.

## Models

ASR uses `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`. The default `小智` wake word uses the dedicated `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` keyword spotter. TTS uses `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit` through the pinned `mlx-audio==0.4.8` runtime, with `Serena` as the default Mandarin voice.

Models and Python runtimes are explicit local artifacts and remain Git-ignored. Install KWS and Qwen TTS with:

```bash
packages/voice-service/scripts/download-kws-model.sh
packages/voice-service/scripts/setup-mlx-tts.sh --download-model
```

The KWS installer pins the official GitHub release archive SHA-256 and atomically installs it after validating the model files and the partial-pinyin encoding for `小智`. Set `VOICE_KWS_ARCHIVE_URL` for an exact mirror or offline archive URL. The MLX setup script creates an isolated Python 3.13 environment under `.agent-data`, installs the pinned runtime, and downloads the selected Hugging Face model only when `--download-model` is passed.

The sherpa-onnx and MLX-Audio runtimes are Apache-2.0. Confirm the selected model's redistribution requirements before bundling weights in an application installer.

## Run Locally

```bash
bun run --cwd packages/voice-service build
VOICE_ASR_MODEL_DIR="$PWD/packages/desktop/.agent-data/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30" \
VOICE_KWS_MODEL_DIR="$PWD/packages/desktop/.agent-data/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01" \
VOICE_TTS_PYTHON="$PWD/packages/desktop/.agent-data/tts-runtime/bin/python" \
node packages/voice-service/dist/main.js
```

The default endpoint is `http://127.0.0.1:17863`. Electron launches this same process automatically when no remote URL is configured.
The managed service runs with Node for sherpa ASR/KWS and keeps one persistent Python MLX worker for TTS. Set `VOICE_SERVICE_NODE_BINARY` or `VOICE_TTS_PYTHON` when those runtimes are not at their default paths. Packaged builds can bundle both runtimes under `resources/voice-service`.

## Deploy Remotely

Set these variables on the service host:

- `VOICE_SERVICE_HOST=0.0.0.0`
- `VOICE_SERVICE_PORT=17863`
- `VOICE_SERVICE_TOKEN=<secret>`
- `VOICE_ASR_MODEL_DIR=/absolute/model/path`
- `VOICE_KWS_MODEL_DIR=/absolute/model/path`
- `VOICE_TTS_PYTHON=/absolute/runtime/bin/python`
- `VOICE_TTS_WORKER_SCRIPT=/absolute/mlx_tts_worker.py`
- `VOICE_TTS_MODEL=mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit`
- `VOICE_TTS_VOICE=Serena`
- `VOICE_TTS_STREAMING_INTERVAL=0.32`

Non-loopback binding is rejected without a token. Terminate TLS at the reverse proxy and expose `/v1/asr` and `/v1/tts/stream` with WebSocket upgrades plus `/v1/tts` and `/health` over HTTPS.

Configure the desktop client with:

```bash
VOICE_SERVICE_URL=https://voice.example.com \
VOICE_SERVICE_TOKEN=<secret> \
bun run dev:desktop
```

If the remote service is unavailable, the desktop tries its managed localhost service. TTS failures are explicit and never fall back to macOS `say` or browser speech synthesis.

## Protocol

Connect to `WS /v1/asr`, send a JSON `start` control, then binary mono 16 kHz float32 little-endian PCM frames. A default wake session sends `wakeWord: "小智"`: `ready.strategy` is `kws`, a `keyword` event switches that same socket to streaming ASR, and later PCM produces the command transcript. Custom wake words or missing KWS assets explicitly fall back to `ready.strategy: "asr"`. The server also emits `partial`, `final`, and `finished`; `finished` acknowledges every explicit `finish`, including recordings with no recognized text. All events and controls carry the same `sessionId` and `generation`.

`GET /health` reports separate `asr`, `kws`, `tts`, `ttsLoading`, and `ttsError` fields. KWS or TTS load failure does not disable ASR.

Connect to `WS /v1/tts/stream` and send a JSON `start` with `sessionId`, `generation`, `text`, optional `voice`, and optional `speed`. The service responds with JSON `started`, raw mono 24 kHz signed 16-bit little-endian PCM frames, then `finished`, `cancelled`, or `error`. A matching JSON `cancel` stops only that generation. Socket output is bounded and an overflowing consumer is cancelled explicitly.

The compatibility `POST /v1/tts` endpoint remains available and collects the same PCM stream into a complete 16-bit WAV. The desktop streaming path does not use it.
