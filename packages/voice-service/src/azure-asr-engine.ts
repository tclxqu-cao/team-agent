import * as speech from "microsoft-cognitiveservices-speech-sdk";
import type { AsrResultEvent, AsrSession } from "./asr-engine.js";
import type { VoiceServiceConfig } from "./config.js";

export type AzureSpeechOptions = NonNullable<VoiceServiceConfig["azure"]>;

/** Azure expects little-endian PCM16; the public voice protocol uses float32. */
export function float32ToPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new ArrayBuffer(samples.length * 2);
  const view = new DataView(pcm);
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) throw new Error("PCM samples must be finite");
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return pcm;
}

export class AzureAsrEngine {
  constructor(
    private readonly options: AzureSpeechOptions,
    private readonly sdk: typeof speech = speech,
    private readonly finishTimeoutMs = 10_000,
  ) {}

  createSession(sessionId: string, generation: number, emit: (event: AsrResultEvent) => void): AsrSession {
    const sdk = this.sdk;
    const finishTimeoutMs = this.finishTimeoutMs;
    let closed = false;
    let utteranceId = 0;
    let run: ReturnType<typeof start>;

    const start = () => {
      const config = sdk.SpeechConfig.fromSubscription(this.options.key, this.options.region);
      config.speechRecognitionLanguage = this.options.language;
      const input = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16_000, 16, 1));
      const audio = sdk.AudioConfig.fromStreamInput(input);
      const recognizer = new sdk.SpeechRecognizer(config, audio);
      config.close();
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      let resolveDone!: () => void;
      let rejectDone!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      void ready.catch(() => undefined);
      void done.catch(() => undefined);
      const state = {
        ready, done, input, finishing: false, disposed: false,
        dispose: () => {
          if (state.disposed) return;
          state.disposed = true;
          input.close();
          recognizer.close();
          audio.close();
          const error = new Error("Azure recognition session closed");
          rejectReady(error);
          rejectDone(error);
        },
      };
      const fail = () => {
        if (state.disposed || closed) return;
        // SDK errorDetails can contain service URLs and credentials. Never forward it.
        const message = "Azure speech recognition failed; check credentials, region, network and quota";
        rejectReady(new Error(message));
        rejectDone(new Error(message));
        emit({ type: "error", sessionId, generation, code: "azure-asr-failed", message });
        state.dispose();
      };
      recognizer.recognizing = (_sender, event) => {
        if (!closed && !state.disposed && event.result.text.trim()) {
          emit({ type: "partial", sessionId, generation, text: event.result.text.trim() });
        }
      };
      recognizer.recognized = (_sender, event) => {
        if (!closed && !state.disposed && event.result.reason === sdk.ResultReason.RecognizedSpeech && event.result.text.trim()) {
          emit({ type: "final", sessionId, generation, utteranceId: ++utteranceId, text: event.result.text.trim() });
        }
      };
      recognizer.canceled = (_sender, event) => {
        if (event.reason === sdk.CancellationReason.EndOfStream && state.finishing) return;
        fail();
      };
      recognizer.sessionStopped = () => {
        if (state.finishing) resolveDone();
        else fail();
      };
      try { recognizer.startContinuousRecognitionAsync(resolveReady, fail); }
      catch { state.dispose(); throw new Error("Azure recognition could not start"); }
      return state;
    };
    const safeStart = () => {
      try { return start(); }
      catch { throw new Error("Azure recognition could not start; check speech configuration"); }
    };
    run = safeStart();
    return {
      get ready() { return run.ready; },
      acceptPcm(samples) {
        if (closed || run.disposed || run.finishing) throw new Error("Azure recognition is not accepting audio");
        run.input.write(float32ToPcm16(samples));
      },
      async finish() {
        const active = run;
        if (closed || active.disposed) throw new Error("Azure recognition session closed");
        await active.ready;
        active.finishing = true;
        // Closing input drains Azure's final result. Stopping recognition here can truncate it.
        active.input.close();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            active.done,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Azure recognition finish timed out")), finishTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          active.dispose();
        }
      },
      reset() {
        if (closed) throw new Error("Azure recognition session closed");
        run.dispose();
        run = safeStart();
        return run.ready;
      },
      close() { closed = true; run.dispose(); },
    };
  }
}
