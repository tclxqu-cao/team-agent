import { describe, expect, it } from "vitest";
import type { TtsRequest } from "./protocol";
import { TtsEngine, type OfflineTtsLike } from "./tts-engine";

const request: TtsRequest = {
  sessionId: "voice-1",
  generation: 2,
  text: "你好世界",
  voice: "default-zh-female",
  speed: 1.25,
};

describe("TtsEngine", () => {
  it("maps the request to speaker zero and returns a WAV", async () => {
    const calls: any[] = [];
    const offline: OfflineTtsLike = {
      sampleRate: 24_000,
      async generateAsync(input) {
        calls.push(input);
        return { samples: new Float32Array([0.25, -0.5]), sampleRate: 24_000 };
      },
    };
    const result = await new TtsEngine(offline).generate(request, new AbortController().signal);
    expect(calls[0]).toMatchObject({ text: "你好世界", sid: 0, speed: 1.25 });
    expect(result.sampleRate).toBe(24_000);
    expect(result.wav.toString("ascii", 0, 4)).toBe("RIFF");
  });

  it("serializes local synthesis jobs", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const offline: OfflineTtsLike = {
      sampleRate: 24_000,
      async generateAsync() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { samples: new Float32Array([0]), sampleRate: 24_000 };
      },
    };
    const engine = new TtsEngine(offline);
    const first = engine.generate(request, new AbortController().signal);
    const second = engine.generate({ ...request, generation: 3 }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(maxActive).toBe(1);
    expect(releases).toHaveLength(1);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(1);
    releases.shift()?.();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
  });

  it("propagates cancellation through the progress callback", async () => {
    const controller = new AbortController();
    let progressResult: number | boolean | void = 1;
    const offline: OfflineTtsLike = {
      sampleRate: 24_000,
      async generateAsync(input) {
        controller.abort();
        progressResult = input.onProgress?.({ samples: new Float32Array([0]), progress: 0.5 });
        return { samples: new Float32Array(), sampleRate: 24_000 };
      },
    };
    await expect(new TtsEngine(offline).generate(request, controller.signal)).rejects.toThrow("aborted");
    expect(progressResult).toBe(false);
  });
});
