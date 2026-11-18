# Voice Service

Standalone local or remote Chinese voice service for Customer Agent. It exposes streaming ASR over WebSocket while keeping sherpa-onnx inference outside Electron's main process.

## Models

ASR uses `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`. The default `小智` wake word uses the dedicated `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` keyword spotter.

Models are explicit local artifacts and remain Git-ignored. Install KWS with:

```bash
packages/voice-service/scripts/download-kws-model.sh
```

The KWS installer pins the official GitHub release archive SHA-256 and atomically installs it after validating the model files and the partial-pinyin encoding for `小智`. Set `VOICE_KWS_ARCHIVE_URL` for an exact mirror or offline archive URL.

The sherpa-onnx runtime is Apache-2.0. Confirm the selected model's redistribution requirements before bundling weights in an application installer.

## Run Locally

```bash
bun run --cwd packages/voice-service build
VOICE_ASR_MODEL_DIR="$PWD/packages/desktop/.agent-data/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30" \
VOICE_KWS_MODEL_DIR="$PWD/packages/desktop/.agent-data/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01" \
node packages/voice-service/dist/main.js
```

The default endpoint is `http://127.0.0.1:17863`. Electron launches this same process automatically when no remote URL is configured.
The managed service runs with Node for sherpa ASR/KWS. Set `VOICE_SERVICE_NODE_BINARY` when Node is not at its default path.

## Deploy Remotely

Set these variables on the service host:

- `VOICE_SERVICE_HOST=0.0.0.0`
- `VOICE_SERVICE_PORT=17863`
- `VOICE_SERVICE_TOKEN=<secret>`
- `VOICE_ASR_MODEL_DIR=/absolute/model/path`
- `VOICE_KWS_MODEL_DIR=/absolute/model/path`

Non-loopback binding is rejected without a token. Terminate TLS at the reverse proxy and expose `/v1/asr` with WebSocket upgrades and `/health` over HTTPS.

Configure the desktop client with:

```bash
VOICE_SERVICE_URL=https://voice.example.com \
VOICE_SERVICE_TOKEN=<secret> \
bun run dev:desktop
```

If the remote service is unavailable, the desktop tries its managed localhost service.

## Protocol

Connect to `WS /v1/asr`, send a JSON `start` control, then binary mono 16 kHz float32 little-endian PCM frames. A default wake session sends `wakeWord: "小智"`: `ready.strategy` is `kws`, a `keyword` event switches that same socket to streaming ASR, and later PCM produces the command transcript. Custom wake words or missing KWS assets explicitly fall back to `ready.strategy: "asr"`. The server also emits `partial`, `final`, and `finished`; `finished` acknowledges every explicit `finish`, including recordings with no recognized text. All events and controls carry the same `sessionId` and `generation`.

`GET /health` reports `asr` and `kws` availability. A KWS load failure does not disable ASR.
