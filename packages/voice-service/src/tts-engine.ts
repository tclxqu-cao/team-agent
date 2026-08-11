import type { TtsRequest } from "./protocol.js";
import { encodeFloat32Wav } from "./wav.js";

export interface OfflineTtsLike {
  sampleRate: number;
  generateAsync(input: {
    text: string;
    sid: number;
    speed: number;
    onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void;
  }): Promise<{ samples: Float32Array; sampleRate: number }>;
}

export class TtsEngine {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly offline: OfflineTtsLike) {}

  generate(request: TtsRequest, signal: AbortSignal): Promise<{ wav: Buffer; sampleRate: number }> {
    const run = this.tail.then(async () => {
      if (signal.aborted) throw new Error("TTS generation aborted");
      const generated = await this.offline.generateAsync({
        text: request.text,
        sid: 0,
        speed: request.speed,
        onProgress: () => !signal.aborted,
      });
      if (signal.aborted) throw new Error("TTS generation aborted");
      const sampleRate = generated.sampleRate || this.offline.sampleRate;
      return {
        wav: encodeFloat32Wav(generated.samples, sampleRate),
        sampleRate,
      };
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
