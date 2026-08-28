import type { TtsRequest } from "./protocol.js";
import { encodeFloat32Wav } from "./wav.js";

export interface OfflineTtsLike {
  sampleRate: number;
  generateAsync(input: {
    text: string;
    sid: number;
    speed: number;
    enableExternalBuffer: boolean;
  }): Promise<{ samples: Float32Array; sampleRate: number }>;
}

export const MAX_ADMITTED_TTS_JOBS = 2;

export class TtsOverloadedError extends Error {
  readonly code = "tts-overloaded";

  constructor() {
    super("TTS synthesis capacity exceeded");
    this.name = "TtsOverloadedError";
  }
}

export class TtsEngine {
  private tail: Promise<void> = Promise.resolve();
  private admittedJobs = 0;

  constructor(private readonly offline: OfflineTtsLike) {}

  generate(request: TtsRequest, signal: AbortSignal): Promise<{ wav: Buffer; sampleRate: number }> {
    if (signal.aborted) return Promise.reject(new Error("TTS generation aborted"));
    if (this.admittedJobs >= MAX_ADMITTED_TTS_JOBS) {
      return Promise.reject(new TtsOverloadedError());
    }
    this.admittedJobs += 1;

    const run = this.tail.then(async () => {
      if (signal.aborted) throw new Error("TTS generation aborted");
      const generated = await this.offline.generateAsync({
        text: request.text,
        sid: 0,
        speed: request.speed,
        enableExternalBuffer: true,
      });
      if (signal.aborted) throw new Error("TTS generation aborted");
      const sampleRate = generated.sampleRate || this.offline.sampleRate;
      return {
        wav: encodeFloat32Wav(generated.samples, sampleRate),
        sampleRate,
      };
    });
    this.tail = run.then(() => undefined, () => undefined);
    const reserved = run.finally(() => {
      this.admittedJobs -= 1;
    });
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(new Error("TTS generation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    return Promise.race([reserved, aborted]).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  }
}
