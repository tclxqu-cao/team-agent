# MLX Qwen Streaming TTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace whole-utterance Melo WAV playback with warm, cancellable Qwen3-TTS PCM streaming on the target M3 Pro and push the verified branch.

**Architecture:** Keep the Node voice service as the ASR/KWS/TTS gateway, but move TTS inference into one persistent MLX Python worker using framed stdio. Stream authenticated generation-scoped PCM over WebSocket to Electron, then play it through a bounded AudioWorklet ring buffer and use renderer drain acknowledgements to preserve wake and barge-in state.

**Tech Stack:** TypeScript, Node.js, `ws`, Electron 32, Web Audio AudioWorklet, Python 3, `mlx-audio==0.4.8`, Qwen3-TTS 0.6B CustomVoice 6-bit, Vitest, Python `unittest`.

## Global Constraints

- Warm first audible audio must be 200-700 ms for both the short and 95-character measurements.
- PCM must begin playing before the utterance finishes synthesizing.
- Every queue is bounded; no sherpa-onnx `onProgress` callback may be restored.
- Any user speech, text submission, dictation start, manual stop, or newer response cancels generation and flushes buffered playback.
- Existing ASR, KWS, wake, dictation, barge-in, and local/remote provider selection remain compatible.
- Do not fall back to `say`, browser `speechSynthesis.speak`, temporary WAV files, or `afplay`.
- Do not commit model files, Hugging Face cache contents, virtual environments, `.agent-data`, `.next`, `.sessions`, or `.agents` runtime state.
- This project does not execute `git-ai` for this task.

---

### Task 1: Persistent MLX Worker And Framed Node Bridge

**Files:**
- Create: `packages/voice-service/python/mlx_tts_worker.py`
- Create: `packages/voice-service/python/test_mlx_tts_worker.py`
- Create: `packages/voice-service/src/framed-process.ts`
- Create: `packages/voice-service/src/framed-process.test.ts`
- Create: `packages/voice-service/src/mlx-tts-engine.ts`
- Create: `packages/voice-service/src/mlx-tts-engine.test.ts`
- Create: `packages/voice-service/scripts/setup-mlx-tts.sh`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `MlxTtsEngine.start(options): Promise<MlxTtsEngine>`.
- Produces: `MlxTtsEngine.stream(request, signal): Promise<TtsPcmStream>` where `TtsPcmStream` exposes `sampleRate`, `channels`, `sampleFormat`, `chunks: AsyncIterable<Buffer>`, and `completed: Promise<void>`.
- Produces: stdin JSONL commands `synthesize`, `cancel`, `shutdown`; stdout frame kinds `0x01` JSON and `0x02` PCM.

- [ ] **Step 1: Write failing framing and worker conversion tests**

```ts
expect(decodeFrames(Buffer.concat([jsonFrame, pcmFrame]))).toEqual([
  { kind: "json", payload: Buffer.from('{"type":"ready"}') },
  { kind: "pcm", payload: Buffer.from([0, 1, 2, 3]) },
]);
```

```python
def test_float_pcm_is_clipped_and_encoded_little_endian():
    pcm = float_to_s16le([-2.0, -0.5, 0.5, 2.0])
    self.assertEqual(struct.unpack("<hhhh", pcm), (-32768, -16384, 16384, 32767))
```

- [ ] **Step 2: Run tests and verify the new modules are absent**

Run: `bunx vitest run packages/voice-service/src/framed-process.test.ts packages/voice-service/src/mlx-tts-engine.test.ts`

Run: `python3 -m unittest packages/voice-service/python/test_mlx_tts_worker.py`

Expected: FAIL because the framing, engine, and worker modules do not exist.

- [ ] **Step 3: Implement deterministic framing and a bounded async PCM queue**

```ts
export interface DecodedFrame { kind: "json" | "pcm"; payload: Buffer }
export function encodeFrame(kind: 1 | 2, payload: Buffer): Buffer;
export class FrameDecoder { push(chunk: Buffer): DecodedFrame[]; }
export class BoundedAsyncQueue<T> {
  constructor(capacity: number, onFull: () => void);
  push(value: T): boolean;
  close(error?: Error): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}
```

The decoder rejects unknown kinds and payloads over 1 MiB. The queue capacity is eight PCM chunks and pauses child stdout when full, resuming it when a consumer removes an item.

- [ ] **Step 4: Implement the MLX Python worker with a fake test backend**

```python
def synthesize(model, command, cancelled):
    for result in model.generate(
        text=command["text"],
        voice=command.get("voice", "Serena"),
        language="Chinese",
        speed=command.get("speed", 1.0),
        stream=True,
        streaming_interval=command.get("streamingInterval", 0.32),
    ):
        if cancelled.is_set():
            return "cancelled"
        write_pcm_frame(float_to_s16le(result.audio))
```

The stdin reader stays on the main thread, synthesis runs on one background thread, and `cancel` sets the active event without waiting for the utterance. `--fake` emits deterministic 24 kHz chunks without importing MLX.

- [ ] **Step 5: Implement `MlxTtsEngine` process lifecycle and cancellation**

```ts
export interface TtsPcmStream {
  sampleRate: 24_000;
  channels: 1;
  sampleFormat: "s16le";
  chunks: AsyncIterable<Buffer>;
  completed: Promise<void>;
}
```

Startup waits for `ready` with a 120-second timeout. Only one active generation is accepted; a newer request cancels the previous request. Worker exit rejects readiness and any active stream.

- [ ] **Step 6: Add the pinned setup script**

```bash
uv venv --python 3.13 "$RUNTIME_DIR"
uv pip install --python "$RUNTIME_DIR/bin/python" "mlx-audio==0.4.8"
"$RUNTIME_DIR/bin/python" -c 'import mlx_audio; print("mlx-audio ready")'
```

The script defaults to `packages/desktop/.agent-data/tts-runtime` and downloads `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit` into the configured Hugging Face cache only when `--download-model` is passed.

- [ ] **Step 7: Run focused tests and commit**

Run: `bunx vitest run packages/voice-service/src/framed-process.test.ts packages/voice-service/src/mlx-tts-engine.test.ts`

Run: `python3 -m unittest packages/voice-service/python/test_mlx_tts_worker.py`

Expected: PASS.

```bash
git add .gitignore packages/voice-service/python packages/voice-service/src/framed-process.ts packages/voice-service/src/framed-process.test.ts packages/voice-service/src/mlx-tts-engine.ts packages/voice-service/src/mlx-tts-engine.test.ts packages/voice-service/scripts/setup-mlx-tts.sh
git commit -m "feat(voice): add persistent MLX streaming TTS worker"
```

### Task 2: Voice-Service Streaming TTS Protocol

**Files:**
- Modify: `packages/voice-service/src/protocol.ts`
- Modify: `packages/voice-service/src/protocol.test.ts`
- Modify: `packages/voice-service/src/server.ts`
- Modify: `packages/voice-service/src/server.test.ts`
- Modify: `packages/voice-service/src/config.ts`
- Modify: `packages/voice-service/src/config.test.ts`
- Modify: `packages/voice-service/src/main.ts`
- Modify: `packages/voice-service/src/sherpa-runtime.ts`
- Modify: `packages/voice-service/src/sherpa-runtime.test.ts`
- Modify: `packages/voice-service/README.md`

**Interfaces:**
- Consumes: `MlxTtsEngine.stream(request, signal)` from Task 1.
- Produces: authenticated `WS /v1/tts/stream` with `started`, binary `s16le`, `finished`, `cancelled`, and `error` messages.
- Produces: health fields `tts`, `ttsLoading`, and `ttsError`.

- [ ] **Step 1: Add failing protocol and WebSocket order tests**

```ts
socket.send(JSON.stringify({
  type: "start", sessionId: "voice-1", generation: 12,
  text: "这是回答。", voice: "Serena", speed: 1,
}));
expect(await nextText(socket)).toMatchObject({ type: "started", generation: 12, sampleRate: 24000 });
expect(await nextBinary(socket)).toEqual(Buffer.from([0, 0, 1, 0]));
expect(await nextText(socket)).toEqual({ type: "finished", sessionId: "voice-1", generation: 12 });
```

Cover unauthorized upgrade, invalid start, cancellation on socket close, stale generation rejection, and overflow error.

- [ ] **Step 2: Run focused service tests and verify failure**

Run: `bunx vitest run packages/voice-service/src/protocol.test.ts packages/voice-service/src/server.test.ts packages/voice-service/src/config.test.ts packages/voice-service/src/sherpa-runtime.test.ts`

Expected: FAIL because `/v1/tts/stream` and MLX configuration are absent.

- [ ] **Step 3: Add streaming request/control types and route upgrades by pathname**

```ts
export type TtsStreamControl = TtsStreamStart | {
  type: "cancel";
  sessionId: string;
  generation: number;
};
export function parseTtsStreamControl(raw: string): TtsStreamControl;
```

Create separate ASR and TTS `WebSocketServer` instances so handlers cannot consume the wrong protocol.

- [ ] **Step 4: Stream bounded PCM and propagate cancellation**

```ts
const stream = await engine.stream(start, controller.signal);
sendJson(socket, { type: "started", ...metadata });
for await (const pcm of stream.chunks) {
  if (socket.bufferedAmount > MAX_TTS_SOCKET_BUFFER_BYTES) throw new Error("tts-buffer-overflow");
  await sendBinary(socket, pcm);
}
await stream.completed;
sendJson(socket, { type: "finished", sessionId, generation });
```

Closing the socket or receiving matching `cancel` aborts the engine signal. Stale controls receive an in-band error and never cancel a newer generation.

- [ ] **Step 5: Replace sherpa TTS initialization with the MLX worker**

```ts
const tts = await MlxTtsEngine.start({
  python: config.ttsPython,
  workerScript: config.ttsWorkerScript,
  model: config.ttsModel,
  voice: config.ttsVoice,
  streamingInterval: config.ttsStreamingInterval,
});
```

`createSherpaEngines` returns ASR and KWS only. Main closes the MLX worker during shutdown and reports a nonfatal TTS startup error while keeping ASR/KWS available.

- [ ] **Step 6: Run service regression tests and commit**

Run: `bunx vitest run packages/voice-service/src`

Run: `bun run --cwd packages/voice-service build`

Expected: PASS.

```bash
git add packages/voice-service
git commit -m "feat(voice): expose generation-scoped streaming TTS"
```

### Task 3: Electron Streaming Client And Playback IPC

**Files:**
- Modify: `packages/desktop/main/voice-service-client.ts`
- Modify: `packages/desktop/main/voice-service-client.test.ts`
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`
- Modify: `packages/desktop/main/voice-service-manager.ts`
- Modify: `packages/desktop/main/voice-service-manager.test.ts`

**Interfaces:**
- Consumes: `WS /v1/tts/stream` from Task 2.
- Produces: `VoiceServiceClient.streamSynthesize(request, signal, handlers): Promise<void>`.
- Produces IPC events `tts:start`, `tts:pcm`, `tts:stream-end`, `tts:flush`, and renderer acknowledgement `tts:playback-ended`.

- [ ] **Step 1: Write failing streaming client tests**

```ts
await client.streamSynthesize(request, controller.signal, {
  onStarted: (meta) => events.push(meta),
  onPcm: (pcm) => chunks.push(pcm),
});
expect(chunks).toEqual([Buffer.from([0, 0, 1, 0])]);
```

Cover authentication, start timeout, malformed metadata, binary-before-start, stale generation, cancellation, and `close()` aborting active synthesis.

- [ ] **Step 2: Run client tests and verify failure**

Run: `bunx vitest run packages/desktop/main/voice-service-client.test.ts packages/desktop/main/voice-service-manager.test.ts`

Expected: FAIL because the streaming API and MLX environment propagation are absent.

- [ ] **Step 3: Implement streaming client lifecycle**

```ts
streamSynthesize(
  request: TtsRequest,
  signal: AbortSignal,
  handlers: { onStarted(meta: TtsStreamMetadata): void; onPcm(chunk: Buffer): void },
): Promise<void>;
```

The client validates every control generation, accepts binary only after `started`, and closes with a matching `cancel` on abort.

- [ ] **Step 4: Replace WAV/afplay orchestration with PCM IPC**

Main sends PCM only when `shouldAcceptTtsPlayback(generation, ttsGeneration, ttsSpeaking)` is true. `cancelActiveTts()` aborts the WebSocket and sends `tts:flush`. Synthesis completion sends `tts:stream-end`; only `tts:playback-ended` clears speaking state, emits `tts:end`, and restores wake listening.

Delete `ttsProc`, `ttsAudioPath`, temporary-file writes, `removeTtsAudio`, `attachTtsProcess`, and the `afplay` spawn path.

- [ ] **Step 5: Propagate the MLX worker environment to the managed voice service**

```ts
VOICE_TTS_PYTHON: process.env.VOICE_TTS_PYTHON ?? join(app.getAppPath(), ".agent-data", "tts-runtime", "bin", "python"),
VOICE_TTS_WORKER_SCRIPT: join(app.getAppPath(), "../voice-service/python/mlx_tts_worker.py"),
VOICE_TTS_MODEL: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
```

Development and packaged path resolution are tested independently.

- [ ] **Step 6: Run desktop main tests and commit**

Run: `bunx vitest run packages/desktop/main/voice-service-client.test.ts packages/desktop/main/voice-service-manager.test.ts packages/desktop/main/voice-capture-state.test.ts`

Expected: PASS.

```bash
git add packages/desktop/main packages/desktop/renderer/global.d.ts
git commit -m "feat(desktop): consume streaming TTS PCM"
```

### Task 4: Bounded AudioWorklet Player And Interruption Integration

**Files:**
- Create: `packages/desktop/renderer/public/pcm-audio-worklet.js`
- Create: `packages/desktop/renderer/lib/pcm-stream-player.ts`
- Create: `packages/desktop/renderer/lib/pcm-stream-player.test.ts`
- Modify: `packages/desktop/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/renderer/lib/voice-interruption.ts`
- Modify: `packages/desktop/renderer/lib/voice-interruption.test.ts`
- Modify: `packages/desktop/renderer/lib/speech.ts`
- Modify: `packages/desktop/renderer/lib/speech.test.ts`

**Interfaces:**
- Consumes: preload TTS stream events from Task 3.
- Produces: `PcmStreamPlayer.start(meta)`, `enqueue(pcm)`, `finish(generation)`, and `flush(generation)`.
- Produces: `window.agentApi.ttsPlaybackEnded(generation)` after drain or immediate flush.

- [ ] **Step 1: Write failing bounded player state tests**

```ts
player.start({ generation: 4, sampleRate: 24000, channels: 1, sampleFormat: "s16le" });
player.enqueue(4, pcm);
player.finish(4);
worklet.emit({ type: "drained", generation: 4 });
expect(api.ttsPlaybackEnded).toHaveBeenCalledWith(4);
```

Cover stale chunks, one-second capacity, conversion from `s16le`, drain, underrun recovery, overflow flush, and interruption before first PCM.

- [ ] **Step 2: Run renderer tests and verify failure**

Run: `bunx vitest run packages/desktop/renderer/lib/pcm-stream-player.test.ts packages/desktop/renderer/lib/voice-interruption.test.ts packages/desktop/renderer/lib/speech.test.ts`

Expected: FAIL because `PcmStreamPlayer` does not exist.

- [ ] **Step 3: Implement the AudioWorklet ring buffer**

The processor owns a fixed input-sample-rate ring, begins consumption at 120 ms buffered audio, linearly resamples to the AudioContext rate, outputs silence during underrun, and reports `drained`, `stopped`, or `overflow`. Capacity is exactly one second of input PCM.

```js
registerProcessor("pcm-stream-player", class extends AudioWorkletProcessor {
  process(_inputs, outputs) {
    const output = outputs[0][0];
    // bounded ring read and linear resampling
    return true;
  }
});
```

- [ ] **Step 4: Implement renderer player and bind preload events once**

`PcmStreamPlayer` loads `./pcm-audio-worklet.js`, creates one `AudioWorkletNode`, transfers converted `Float32Array` buffers to its port, and ignores events for noncurrent generations. `ChatView` subscribes on mount and disposes listeners on unmount.

- [ ] **Step 5: Preserve unified interruption semantics**

Manual playback, automatic playback, keyboard send, dictation start, and BARGE_IN continue to use `ttsStop`. Browser speech remains cancellation-only and no code creates `SpeechSynthesisUtterance`.

- [ ] **Step 6: Run renderer regressions, build, and commit**

Run: `bunx vitest run packages/desktop/renderer packages/desktop/main`

Run: `bun run --cwd packages/desktop compile`

Expected: PASS.

```bash
git add packages/desktop/renderer packages/desktop/main/preload.ts packages/desktop/renderer/global.d.ts
git commit -m "feat(desktop): play bounded streaming PCM"
```

### Task 5: Model Setup, Runtime Evidence, Cleanup, And Push

**Files:**
- Modify: `packages/voice-service/README.md`
- Modify only if required by evidence: files from Tasks 1-4
- Update: `/Users/caoqu/.obsidian/wiki/projects/customer-agent/skills/macos-swift-wake-word-electron-tcc.md` through `wiki-capture`

**Interfaces:**
- Consumes: completed streaming implementation.
- Produces: measured target-machine evidence and pushed branch.

- [ ] **Step 1: Install the pinned runtime and download the selected model**

Run: `packages/voice-service/scripts/setup-mlx-tts.sh --download-model`

Expected: Python imports MLX-Audio and the configured model is available in the ignored local cache.

- [ ] **Step 2: Measure standalone worker cold load and warm PCM latency**

Run the worker with the 8-character and existing 95-character texts. Record ready time, first PCM time, completion time, PCM byte count, and process physical footprint using `vmmap -summary`.

Expected: both warm first-PCM measurements are at most 500 ms, leaving up to 200 ms playback buffering budget.

- [ ] **Step 3: Run the full relevant automated suite**

Run: `bunx vitest run packages/voice-service/src packages/desktop/main packages/desktop/renderer`

Run: `python3 -m unittest packages/voice-service/python/test_mlx_tts_worker.py`

Run: `bun run --cwd packages/voice-service build`

Run: `bun run --cwd packages/desktop compile`

Run: `git diff --check`

Expected: every command passes.

- [ ] **Step 4: Start the desktop and capture real playback evidence**

Use the LaunchServices launcher so microphone TCC remains assigned to Electron. Verify an 8-character and 95-character response starts playing before synthesis completes, then trigger deterministic stop and a subsequent response.

Expected logs/process state:

```text
tts started -> first PCM <= 500 ms -> playback started <= 700 ms
old generation cancelled -> worklet flushed -> next generation started
```

Process inspection must show no `afplay`, `say`, temporary `customer-agent-tts-*.wav`, or `speechSynthesis.speak` path.

- [ ] **Step 5: Verify wake and barge-in recovery**

Verify finish, manual cancellation, and synthesis error each restore the expected wake listener mode. During playback, a captured BARGE_IN must stop old audio before the next assistant output begins.

- [ ] **Step 6: Remove only generated runtime noise and review the final diff**

Do not stage `.next`, `.sessions`, `.agents`, model caches, or virtual environments. Preserve unrelated user changes. Review `git diff --stat`, `git diff --check`, and staged paths before committing.

- [ ] **Step 7: Capture reusable findings in the wiki**

Use `wiki-capture` to record the chosen MLX model, measured M3 latency/memory, framed cancellation protocol, AudioWorklet buffering thresholds, and any observed failure modes. Refresh QMD as required by the skill.

- [ ] **Step 8: Commit remaining scoped changes and push without git-ai**

```bash
git add <only scoped source, tests, scripts, and docs>
git commit -m "feat(voice): enable low-latency Qwen streaming speech"
git push origin feature_req_voice_input_wake_word_tts_skin_layout_cq_260804
```

Do not run `git-ai`. Confirm the remote branch points to the final local commit.
