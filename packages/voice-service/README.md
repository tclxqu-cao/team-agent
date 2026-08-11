# Voice Service

Standalone local or remote Chinese voice service for Customer Agent. It exposes streaming ASR over WebSocket and offline TTS over HTTP while keeping sherpa-onnx inference outside Electron's main process.

## Models

ASR uses `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`. TTS uses the single-speaker Chinese/English `vits-melo-tts-zh_en` model converted from MeloTTS.

Models are explicit local artifacts and remain Git-ignored. Install TTS with:

```bash
packages/voice-service/scripts/download-tts-model.sh
```

Set `VOICE_MODEL_MIRROR=https://huggingface.co` to use the upstream Hugging Face host instead of the default mirror. The script pins SHA-256 values for the model, token table, and lexicon.

The sherpa-onnx runtime is Apache-2.0. The downloaded Melo model repository includes its own MIT license. Confirm model redistribution requirements before bundling weights in an application installer.

## Run Locally

```bash
bun run --cwd packages/voice-service build
VOICE_ASR_MODEL_DIR="$PWD/packages/desktop/.agent-data/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30" \
VOICE_TTS_MODEL_DIR="$PWD/packages/desktop/.agent-data/tts-models/vits-melo-tts-zh_en" \
node packages/voice-service/dist/main.js
```

The default endpoint is `http://127.0.0.1:17863`. Electron launches this same process automatically when no remote URL is configured.

## Deploy Remotely

Set these variables on the service host:

- `VOICE_SERVICE_HOST=0.0.0.0`
- `VOICE_SERVICE_PORT=17863`
- `VOICE_SERVICE_TOKEN=<secret>`
- `VOICE_ASR_MODEL_DIR=/absolute/model/path`
- `VOICE_TTS_MODEL_DIR=/absolute/model/path`

Non-loopback binding is rejected without a token. Terminate TLS at the reverse proxy and expose `/v1/asr` with WebSocket upgrades plus `/v1/tts` and `/health` over HTTPS.

Configure the desktop client with:

```bash
VOICE_SERVICE_URL=https://voice.example.com \
VOICE_SERVICE_TOKEN=<secret> \
bun run dev:desktop
```

If the remote service is unavailable, the desktop tries its managed localhost service, then falls back to macOS Speech and `say`.

## Protocol

Connect to `WS /v1/asr`, send a JSON `start` control, then binary mono 16 kHz float32 little-endian PCM frames. The server emits `ready`, `partial`, and `final` JSON events. `reset`, `finish`, and `stop` controls carry the same `sessionId` and `generation`.

Send `POST /v1/tts` with `sessionId`, `generation`, `text`, optional `voice`, and optional `speed`. The response is an IEEE-float WAV and includes `X-Voice-Generation`.
