import { describe, expect, it } from "vitest";
import { AsrEngine, type RecognizerLike, type RecognizerStreamLike } from "./asr-engine";

class FakeStream implements RecognizerStreamLike {
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

class FakeRecognizer implements RecognizerLike {
  stream = new FakeStream();
  text = "";
  endpoint = false;
  resets = 0;

  createStream(): RecognizerStreamLike { return this.stream; }
  isReady(): boolean { return false; }
  decode(): void {}
  getResult(): { text: string } { return { text: this.text }; }
  isEndpoint(): boolean { return this.endpoint; }
  reset(): void {
    this.resets += 1;
    this.text = "";
    this.endpoint = false;
  }
}

describe("AsrEngine sessions", () => {
  it("emits each changed partial once and removes invalid characters", () => {
    const recognizer = new FakeRecognizer();
    const events: unknown[] = [];
    const session = new AsrEngine(recognizer).createSession("voice-1", 4, (event) => events.push(event));

    recognizer.text = "你\uFFFD好";
    session.acceptPcm(new Float32Array([0.1]));
    session.acceptPcm(new Float32Array([0.2]));

    expect(events).toEqual([{
      type: "partial",
      sessionId: "voice-1",
      generation: 4,
      text: "你好",
    }]);
  });

  it("emits an increasing final at each endpoint and resets the stream", () => {
    const recognizer = new FakeRecognizer();
    const events: unknown[] = [];
    const session = new AsrEngine(recognizer).createSession("voice-1", 4, (event) => events.push(event));

    recognizer.text = "第一句";
    recognizer.endpoint = true;
    session.acceptPcm(new Float32Array([0.1]));
    recognizer.text = "第二句";
    recognizer.endpoint = true;
    session.acceptPcm(new Float32Array([0.2]));

    expect(events.filter((event: any) => event.type === "final")).toEqual([
      { type: "final", sessionId: "voice-1", generation: 4, utteranceId: 1, text: "第一句" },
      { type: "final", sessionId: "voice-1", generation: 4, utteranceId: 2, text: "第二句" },
    ]);
    expect(recognizer.resets).toBe(2);
  });

  it("pads explicit finish, emits non-empty final, and resets", () => {
    const recognizer = new FakeRecognizer();
    const events: unknown[] = [];
    const session = new AsrEngine(recognizer).createSession("voice-2", 9, (event) => events.push(event));
    recognizer.text = "最后一句";

    session.finish();

    expect(recognizer.stream.accepted.at(-1)?.length).toBe(6_400);
    expect(events.at(-1)).toEqual({
      type: "final",
      sessionId: "voice-2",
      generation: 9,
      utteranceId: 1,
      text: "最后一句",
    });
    expect(recognizer.resets).toBe(1);
  });

  it("stops accepting PCM after close", () => {
    const recognizer = new FakeRecognizer();
    const session = new AsrEngine(recognizer).createSession("voice-3", 1, () => {});
    session.close();
    expect(() => session.acceptPcm(new Float32Array([0.1]))).toThrow("closed");
  });
});
