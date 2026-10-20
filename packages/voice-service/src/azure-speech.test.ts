import * as speech from "microsoft-cognitiveservices-speech-sdk";
import { once } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { AzureAsrEngine, float32ToPcm16 } from "./azure-asr-engine";
import { AzureTtsEngine } from "./azure-tts-engine";
import { createVoiceServer } from "./server";
import type { AsrResultEvent } from "./asr-engine";

const options = { key: "test-secret-never-forward", region: "eastasia", language: "zh-CN", voice: "zh-CN-XiaoxiaoNeural" };

function fakeSdk() {
  const inputs: Array<{ write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const configs: Array<Record<string, unknown>> = [];
  class Recognizer {
    static instances: Recognizer[] = [];
    recognizing?: speech.SpeechRecognizer["recognizing"];
    recognized?: speech.SpeechRecognizer["recognized"];
    canceled?: speech.SpeechRecognizer["canceled"];
    sessionStopped?: speech.SpeechRecognizer["sessionStopped"];
    close = vi.fn();
    constructor() { Recognizer.instances.push(this); }
    startContinuousRecognitionAsync(callback: () => void) { queueMicrotask(callback); }
    partial(text: string) { this.recognizing?.(this as unknown as speech.SpeechRecognizer, { result: { text } } as speech.SpeechRecognitionEventArgs); }
    final(text: string) { this.recognized?.(this as unknown as speech.SpeechRecognizer, { result: { text, reason: speech.ResultReason.RecognizedSpeech } } as speech.SpeechRecognitionEventArgs); }
    stopped() { this.sessionStopped?.(this as unknown as speech.SpeechRecognizer, {} as speech.SessionEventArgs); }
    fail() { this.canceled?.(this as unknown as speech.SpeechRecognizer, { reason: speech.CancellationReason.Error, errorDetails: options.key } as speech.SpeechRecognitionCanceledEventArgs); }
  }
  class Synthesizer {
    static instances: Synthesizer[] = [];
    synthesizing?: speech.SpeechSynthesizer["synthesizing"];
    close = vi.fn();
    ssml = "";
    success?: (result: speech.SpeechSynthesisResult) => void;
    failure?: (message: string) => void;
    constructor() { Synthesizer.instances.push(this); }
    speakSsmlAsync(ssml: string, success: (result: speech.SpeechSynthesisResult) => void, failure: (message: string) => void) {
      this.ssml = ssml; this.success = success; this.failure = failure;
    }
    chunk(pcm: ArrayBuffer) { this.synthesizing?.(this as unknown as speech.SpeechSynthesizer, { result: { audioData: pcm } } as speech.SpeechSynthesisEventArgs); }
    complete() { this.success?.({ reason: speech.ResultReason.SynthesizingAudioCompleted } as speech.SpeechSynthesisResult); }
  }
  const sdk = {
    ...speech,
    SpeechConfig: { fromSubscription: vi.fn(() => { const config = { close: vi.fn() }; configs.push(config); return config; }) },
    AudioInputStream: { createPushStream: vi.fn(() => { const input = { write: vi.fn(), close: vi.fn() }; inputs.push(input); return input; }) },
    AudioConfig: { fromStreamInput: vi.fn(() => ({ close: vi.fn() })) },
    SpeechRecognizer: Recognizer, SpeechSynthesizer: Synthesizer,
  } as unknown as typeof speech;
  return { sdk, inputs, configs, recognizers: Recognizer.instances, synthesizers: Synthesizer.instances };
}

async function collect(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const values: Buffer[] = [];
  for await (const chunk of chunks) values.push(chunk);
  return Buffer.concat(values);
}

describe("Azure Speech adapters", () => {
  it("redacts synchronous SDK startup failures", async () => {
    const f = fakeSdk();
    vi.mocked(f.sdk.SpeechConfig.fromSubscription).mockImplementation(() => { throw new Error(options.key); });
    expect(() => new AzureAsrEngine(options, f.sdk).createSession("test", 1, () => {})).toThrow("could not start");
    await expect(new AzureTtsEngine(options, f.sdk).stream({ sessionId: "test", generation: 1, text: "test", voice: "Serena", speed: 1 }, new AbortController().signal)).rejects.toThrow("could not start");
  });
  it("clips float PCM to signed little-endian samples and rejects NaN", () => {
    expect([...new Int16Array(float32ToPcm16(new Float32Array([-2, -1, 0, 1, 2]))) ]).toEqual([-32768, -32768, 0, 32767, 32767]);
    expect(() => float32ToPcm16(new Float32Array([NaN]))).toThrow("finite");
  });

  it("drains late final recognition over the real WS server before finished", async () => {
    const f = fakeSdk();
    const service = await createVoiceServer({ host: "127.0.0.1", port: 0, token: null, provider: "azure", asrEngine: new AzureAsrEngine(options, f.sdk) });
    const socket = new WebSocket(`${service.wsUrl}/v1/asr`);
    const events: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));
    try {
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "start", sessionId: "cloud-test", generation: 2, sampleRate: 16_000, mode: "dictation" }));
      await vi.waitFor(() => expect(events[0]?.type).toBe("ready"));
      socket.send(Buffer.from(new Float32Array([-1, 1]).buffer));
      await vi.waitFor(() => expect(f.inputs[0].write).toHaveBeenCalled());
      expect(Buffer.from(f.inputs[0].write.mock.calls[0][0])).toEqual(Buffer.from([0, 128, 255, 127]));
      f.recognizers[0].partial("最后");
      socket.send(JSON.stringify({ type: "finish", sessionId: "cloud-test", generation: 2 }));
      await vi.waitFor(() => expect(f.inputs[0].close).toHaveBeenCalled());
      expect(events.some((event) => event.type === "finished")).toBe(false);
      f.recognizers[0].final("最后一个字。");
      f.recognizers[0].stopped();
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe("finished"));
      expect(events.map((event) => event.type)).toEqual(["ready", "partial", "final", "finished"]);
      const health = await (await fetch(`${service.httpUrl}/health`)).json();
      expect(health.provider).toBe("azure");
      expect(JSON.stringify({ health, events })).not.toContain(options.key);
    } finally { socket.terminate(); await service.close(); }
  });

  it("suppresses stale callbacks after reset and preserves utterance identities", async () => {
    const f = fakeSdk();
    const events: AsrResultEvent[] = [];
    const session = new AzureAsrEngine(options, f.sdk).createSession("test", 1, (event) => events.push(event));
    await session.ready;
    f.recognizers[0].final("第一句");
    await session.reset();
    f.recognizers[0].final("过期");
    f.recognizers[1].final("第二句");
    session.close();
    f.recognizers[1].partial("已关闭");
    expect(events.map((event) => event.type === "final" && [event.utteranceId, event.text])).toEqual([[1, "第一句"], [2, "第二句"]]);
    expect(f.recognizers.every((recognizer) => recognizer.close.mock.calls.length === 1)).toBe(true);
  });

  it("reports a safe Azure failure and bounds final-result waiting", async () => {
    const f = fakeSdk();
    const events: AsrResultEvent[] = [];
    const session = new AzureAsrEngine(options, f.sdk, 10).createSession("test", 1, (event) => events.push(event));
    await session.ready;
    f.recognizers[0].fail();
    expect(events).toMatchObject([{ type: "error", code: "azure-asr-failed" }]);
    expect(JSON.stringify(events)).not.toContain(options.key);
    const second = new AzureAsrEngine(options, f.sdk, 10).createSession("test", 2, () => {});
    await second.ready;
    await expect(second.finish()).rejects.toThrow("timed out");
    expect(f.recognizers[1].close).toHaveBeenCalledOnce();
  });

  it("streams raw PCM with Azure default voice, escaped text and relative speed", async () => {
    const f = fakeSdk();
    const engine = new AzureTtsEngine(options, f.sdk);
    const stream = await engine.stream({ sessionId: "tts", generation: 1, text: '<voice name="bad">&你好', voice: "Serena", speed: 1.25 }, new AbortController().signal);
    const output = collect(stream.chunks);
    f.synthesizers[0].chunk(new Int16Array([-32768, 32767]).buffer);
    f.synthesizers[0].complete();
    expect(await output).toEqual(Buffer.from([0, 128, 255, 127]));
    await stream.completed;
    expect(f.configs[0].speechSynthesisOutputFormat).toBe(speech.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm);
    expect(f.synthesizers[0].ssml).toContain('name="zh-CN-XiaoxiaoNeural"');
    expect(f.synthesizers[0].ssml).toContain('rate="+25%"');
    expect(f.synthesizers[0].ssml).toContain("&lt;voice name=&quot;bad&quot;&gt;&amp;你好");
    expect(f.synthesizers[0].close).toHaveBeenCalledOnce();
    await engine.close();
  });

  it("cancels synthesis, ignores late audio and releases capacity", async () => {
    const f = fakeSdk();
    const engine = new AzureTtsEngine(options, f.sdk);
    const request = { sessionId: "tts", generation: 1, text: "你好", voice: "Serena", speed: 1 };
    const controller = new AbortController();
    const stream = await engine.stream(request, controller.signal);
    controller.abort();
    f.synthesizers[0].chunk(new Int16Array([12]).buffer);
    await expect(collect(stream.chunks)).rejects.toMatchObject({ name: "AbortError" });
    await expect(stream.completed).rejects.toMatchObject({ name: "AbortError" });
    const second = await engine.stream(request, new AbortController().signal);
    f.synthesizers[1].failure?.(options.key);
    await expect(second.completed).rejects.not.toThrow(options.key);
    await expect(collect(second.chunks)).rejects.toThrow("Azure speech synthesis failed");
    expect(f.synthesizers[0].close).toHaveBeenCalledOnce();
    await engine.close();
  });
});
