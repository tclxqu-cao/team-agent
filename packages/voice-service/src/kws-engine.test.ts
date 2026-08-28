import { describe, expect, it } from "vitest";
import {
  KwsEngine,
  type KeywordSpotterLike,
  type KeywordStreamLike,
} from "./kws-engine";

class FakeKeywordStream implements KeywordStreamLike {
  accepted: Float32Array[] = [];
  finished = false;

  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void {
    expect(input.sampleRate).toBe(16_000);
    this.accepted.push(input.samples);
  }

  inputFinished(): void {
    this.finished = true;
  }
}

class FakeKeywordSpotter implements KeywordSpotterLike {
  stream = new FakeKeywordStream();
  keyword = "";
  ready = true;
  resets = 0;

  createStream(): KeywordStreamLike { return this.stream; }
  isReady(): boolean { return this.ready; }
  decode(): void { this.ready = false; }
  getResult(): { keyword: string } { return { keyword: this.keyword }; }
  reset(): void { this.resets += 1; }
}

describe("KwsEngine sessions", () => {
  it("emits a detected keyword once and resets immediately", () => {
    const spotter = new FakeKeywordSpotter();
    const events: unknown[] = [];
    const session = new KwsEngine(spotter).createSession(
      "voice-1",
      7,
      (event) => events.push(event),
    );

    session.acceptPcm(new Float32Array([0.1]));
    spotter.keyword = " 小智 ";
    spotter.ready = true;
    session.acceptPcm(new Float32Array([0.2]));
    spotter.ready = true;
    session.acceptPcm(new Float32Array([0.3]));

    expect(events).toEqual([{
      type: "keyword",
      sessionId: "voice-1",
      generation: 7,
      keyword: "小智",
    }]);
    expect(spotter.resets).toBe(1);
  });

  it("closes the stream and rejects later PCM", () => {
    const spotter = new FakeKeywordSpotter();
    const session = new KwsEngine(spotter).createSession("voice-2", 1, () => {});

    session.close();

    expect(spotter.stream.finished).toBe(true);
    expect(() => session.acceptPcm(new Float32Array([0.1]))).toThrow("closed");
  });
});
