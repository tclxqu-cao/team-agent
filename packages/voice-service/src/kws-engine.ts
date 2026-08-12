export interface KeywordStreamLike {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}

export interface KeywordSpotterLike {
  createStream(): KeywordStreamLike;
  isReady(stream: KeywordStreamLike): boolean;
  decode(stream: KeywordStreamLike): void;
  getResult(stream: KeywordStreamLike): { keyword: string };
  reset(stream: KeywordStreamLike): void;
}

export type KwsResultEvent = {
  type: "keyword";
  sessionId: string;
  generation: number;
  keyword: string;
};

export interface KwsSession {
  acceptPcm(samples: Float32Array): void;
  reset(): void;
  close(): void;
}

const SAMPLE_RATE = 16_000;

export class KwsEngine {
  constructor(private readonly spotter: KeywordSpotterLike) {}

  createSession(
    sessionId: string,
    generation: number,
    emit: (event: KwsResultEvent) => void,
  ): KwsSession {
    const spotter = this.spotter;
    const stream = spotter.createStream();
    let detected = false;
    let closed = false;

    const ensureOpen = () => {
      if (closed) throw new Error("KWS session is closed");
    };
    const reset = () => {
      ensureOpen();
      spotter.reset(stream);
      detected = false;
    };

    return {
      acceptPcm(samples) {
        ensureOpen();
        if (samples.length === 0 || detected) return;
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        while (spotter.isReady(stream)) spotter.decode(stream);
        const keyword = spotter.getResult(stream).keyword.trim();
        if (!keyword) return;
        detected = true;
        spotter.reset(stream);
        emit({ type: "keyword", sessionId, generation, keyword });
      },
      reset,
      close() {
        if (closed) return;
        stream.inputFinished();
        closed = true;
      },
    };
  }
}
