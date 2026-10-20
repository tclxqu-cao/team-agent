import * as speech from "microsoft-cognitiveservices-speech-sdk";
import type { AzureSpeechOptions } from "./azure-asr-engine.js";
import { BoundedAsyncQueue } from "./framed-process.js";
import type { TtsPcmStream } from "./mlx-tts-engine.js";
import type { TtsRequest } from "./protocol.js";
import { TtsOverloadedError } from "./tts-engine.js";

function xml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);
}

export class AzureTtsEngine {
  private readonly active = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: AzureSpeechOptions, private readonly sdk: typeof speech = speech) {}

  async stream(request: TtsRequest, signal: AbortSignal): Promise<TtsPcmStream> {
    if (this.closed) throw new Error("Azure synthesis engine closed");
    if (signal.aborted) throw new DOMException("Synthesis cancelled", "AbortError");
    if (this.active.size >= 2) throw new TtsOverloadedError();
    const sdk = this.sdk;
    let synthesizer: speech.SpeechSynthesizer;
    try {
      const config = sdk.SpeechConfig.fromSubscription(this.options.key, this.options.region);
      try {
        config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
        synthesizer = new sdk.SpeechSynthesizer(config, null);
      } finally { config.close(); }
    } catch { throw new Error("Azure synthesis could not start; check speech configuration"); }
    const queue = new BoundedAsyncQueue<Buffer>(4096);
    let settled = false;
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void completed.catch(() => undefined);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.active.delete(abort);
      queue.close(error);
      if (error) rejectDone(error);
      else resolveDone();
      synthesizer.close();
    };
    const abort = () => finish(new DOMException("Synthesis cancelled", "AbortError"));
    this.active.add(abort);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(new Error("Azure synthesis timed out")), 60_000);
    synthesizer.synthesizing = (_sender, event) => {
      if (settled) return;
      const pcm = Buffer.from(event.result.audioData);
      bytes += pcm.length;
      if (bytes > 16 * 1024 * 1024 || pcm.length % 2 !== 0) {
        finish(new Error("Azure synthesis audio exceeds buffer limit or has invalid PCM"));
        return;
      }
      // Bound each WS packet's playback time to 100 ms for cancellation and pacing.
      for (let offset = 0; offset < pcm.length; offset += 4800) {
        if (!queue.push(Buffer.from(pcm.subarray(offset, offset + 4800)))) {
          finish(new Error("Azure synthesis PCM queue overflow"));
          return;
        }
      }
    };
    const voice = request.voice === "Serena" ? this.options.voice : request.voice;
    if (!/^[a-zA-Z0-9-]+Neural$/.test(voice)) {
      finish(new Error("Azure synthesis requires a neural voice name"));
    } else {
      const percent = Math.round((request.speed - 1) * 100);
      const rate = `${percent >= 0 ? "+" : ""}${percent}%`;
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(this.options.language)}"><voice name="${xml(voice)}"><prosody rate="${rate}">${xml(request.text)}</prosody></voice></speak>`;
      try {
        synthesizer.speakSsmlAsync(ssml, (result) => {
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted && bytes > 0) finish();
          else finish(new Error("Azure speech synthesis failed; check credentials, region, voice and quota"));
        }, () => finish(new Error("Azure speech synthesis failed; check credentials, region, network and quota")));
      } catch {
        finish(new Error("Azure speech synthesis failed"));
      }
    }
    return { sampleRate: 24_000, channels: 1, sampleFormat: "s16le", chunks: queue, completed };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const abort of [...this.active]) abort();
  }
}
