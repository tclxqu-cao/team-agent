# Local Chinese ASR POC

This directory evaluates sherpa-onnx without changing the production Swift wake listener. Dependencies, models, and generated audio stay local and ignored by Git.

## Setup

```bash
npm install --prefix packages/desktop/asr-poc --no-package-lock
packages/desktop/asr-poc/download-model.sh
```

The POC pins `sherpa-onnx-node@1.13.4`. The `1.13.5` JavaScript package was published before its matching macOS arm64 binary package and is not usable from the configured registry. Version 1.13.4 uses Node-API and loads under both the local Node runtime and Electron's Node version without rebuilding.

The selected streaming Zipformer Chinese INT8 model is about 126 MiB. The streaming Paraformer bilingual alternative is about 999 MiB, so it is reserved for a later quality comparison.

The sherpa-onnx runtime package is Apache-2.0. The selected model archive's README identifies its training source but does not declare a model-weight license. It is suitable for this local POC; redistribution or commercial shipping requires separate upstream license confirmation.

If GitHub release downloads stall while the macOS system proxy is enabled but not exported to the shell, pass it explicitly for setup:

```bash
HTTPS_PROXY=http://127.0.0.1:7897 packages/desktop/asr-poc/download-model.sh
```

## File Input

```bash
MODEL_DIR="$(packages/desktop/asr-poc/download-model.sh)"
packages/desktop/asr-poc/run.sh \
  --model-dir "$MODEL_DIR" \
  --input /absolute/path/to/audio.aiff \
  --json
```

FFmpeg handles WAV, AIFF, CAF, and other supported inputs and always supplies mono 16 kHz float PCM to the recognizer.

## Microphone Input

List AVFoundation audio devices:

```bash
ffmpeg -f avfoundation -list_devices true -i "" 2>&1
```

Start recognition with the audio device index shown in the list:

```bash
MODEL_DIR="$(packages/desktop/asr-poc/download-model.sh)"
packages/desktop/asr-poc/run.sh \
  --model-dir "$MODEL_DIR" \
  --microphone 0
```

Press Ctrl-C to stop. macOS may require microphone permission for the terminal application that launches FFmpeg. This permission result does not prove Electron TCC behavior.

## Accuracy Score

```bash
node packages/desktop/asr-poc/evaluate.mjs \
  "小智请打开窗口" \
  "小志请打开窗口"
```

The score normalizes case, spacing, and punctuation, then reports Unicode character edit distance and accuracy. Runtime events report addon load, model load, first partial, final latency, CPU time, and RSS.

## 2026-08-11 Results

Three deterministic Tingting phrases were recognized with 100% normalized character accuracy:

- `你好小智请打开窗口`
- `帮我查询明天上海的天气`
- `这个问题有点复杂我们先看第一步再决定下一步`

Across those runs, addon load was 7-8 ms, model load was 1.44-1.50 s, first partial during faster-than-real-time file decoding was 102-117 ms, final was 194-349 ms, and RSS was 472-483 MiB. The model emitted no Chinese punctuation. One partial contained an invalid replacement character while its final was correct; the display path now filters those characters.

An Electron 32.3.3 main-process probe (Node 20.18.1, modules 128, N-API 9) loaded the addon and ran the model without rebuilding. `sherpa.readWave()` must be called with `enableExternalBuffer=false` under Electron 32; its default external buffer is rejected. The POC uses ordinary `Float32Array` data from FFmpeg and does not hit this restriction.

AVFoundation microphone device 2 opened and streamed without a permission or FFmpeg error. No physical speech was present during the capture window, so live microphone recognition remains a manual acceptance item. Roughly 22 seconds of idle capture used about 7.3 CPU seconds and 470 MiB RSS.

The current recommendation is to retain Swift microphone capture, calibrated VAD, voice processing, and TTS barge-in behavior. If human speech quality is better in manual acceptance, replace only the ASR backend with one long-lived sherpa recognizer so its model load cost is paid once. Directly replacing the whole Swift helper would discard working TCC and interruption behavior without evidence.
