# Voice Service

Standalone local or remote Chinese voice service for Customer Agent. It exposes streaming ASR over WebSocket while keeping sherpa-onnx inference outside Electron's main process.

## Models

ASR uses `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`. The default `小智` wake word uses the dedicated `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` keyword spotter.

From a clean checkout, run these commands at the repository root. Use Node 22.22 or newer with npm, and a Bash environment with `curl`, `tar` (bzip2), and `shasum`:

```bash
npm run voice:install
npm run voice:verify
```

`voice:install` downloads both official archives (~158 MiB total), checks their pinned SHA-256 hashes, and installs the verified models under the Git-ignored `packages/desktop/.agent-data` directory. A repeat run checks the existing weights, token tables, and `小智` keyword without downloading again. If an existing directory fails verification, move it aside and rerun the installer.

`voice:verify` checks an existing installation offline and exits with an error if either model fails verification. Both commands can run before installing workspace dependencies.

Set `VOICE_ASR_ARCHIVE_URL` or `VOICE_KWS_ARCHIVE_URL` to an exact mirror or local `file:///absolute/path/to/archive.tar.bz2` URL. Mirrors must match the pinned hashes. Use `HTTPS_PROXY` when GitHub downloads require a proxy. The installer and verifier both honor `VOICE_ASR_MODEL_DIR` and `VOICE_KWS_MODEL_DIR` for alternate installation paths.

The sherpa-onnx runtime is Apache-2.0. Confirm the selected model's redistribution requirements before bundling weights in an application installer.

## Run Locally

Once the workspace dependencies are installed, `voice:verify:runtime` builds the service and checks that both sherpa engines can process a short silent audio buffer. It runs without binding a port or using a microphone.

```bash
npm run voice:verify:runtime
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
