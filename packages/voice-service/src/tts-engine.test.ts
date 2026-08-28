import { describe, expect, it } from "vitest";
import type { TtsRequest } from "./protocol";
import {
  MAX_ADMITTED_TTS_JOBS,
  TtsEngine,
  TtsOverloadedError,
  type OfflineTtsLike,
} from "./tts-engine";

const request: TtsRequest = {
  sessionId: "voice-1",
  generation: 2,
  text: "你好世界",
  voice: "default-zh-female",
  speed: 1.25,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const audio = { samples: new Float32Array([0]), sampleRate: 24_000 };

describe("TtsEngine", () => {
  it("uses external final buffers without registering a progress callback", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const offline: OfflineTtsLike = {
      sampleRate: 24_000,
      async generateAsync(input) {
        calls.push(input);
        return { samples: new Float32Array([0.25, -0.5]), sampleRate: 24_000 };
      },
    };
    const result = await new TtsEngine(offline).generate(request, new AbortController().signal);
    expect(calls[0]).toEqual({
      text: "你好世界",
      sid: 0,
      speed: 1.25,
      enableExternalBuffer: true,
    });
    expect(calls[0]).not.toHaveProperty("onProgress");
    expect(result.sampleRate).toBe(24_000);
    expect(result.wav.toString("ascii", 0, 4)).toBe("RIFF");
  });

  it("rejects cancellation before native entry without occupying capacity", async () => {
    let calls = 0;
    const offline: OfflineTtsLike = {
      sampleRate: 24_000,
      async generateAsync() {
        calls += 1;
        return audio;
      },
    };
    const engine = new TtsEngine(offline);
    const controller = new AbortController();
    controller.abort();

    await expect(engine.generate(request, controller.signal)).rejects.toThrow("aborted");
    await expect(engine.generate(request, new AbortController().signal)).resolves.toMatchObject({ sampleRate: 24_000 });
    expect(calls).toBe(1);
  });

  it("settles active cancellation promptly and discards the native result", async () => {
    const result = deferred<{ samples: Float32Array; sampleRate: number }>();
    let started = false;
    const offline: OfflineTtsLike = {
      sampleRate: 24_000,
      async generateAsync() {
        started = true;
        return result.promise;
      },
    };
    const controller = new AbortController();
    const pending = new TtsEngine(offline).generate(request, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(true);

    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    result.resolve(audio);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("settles queued cancellation promptly without releasing its reserved slot", async () => {
    const results = [
      deferred<{ samples: Float32Array; sampleRate: number }>(),
      deferred<{ samples: Float32Array; sampleRate: number }>(),
    ];
    let calls = 0;
    const offline: OfflineTtsLike = {
      sampleRate: 24_000,
      async generateAsync() {
        return results[calls++].promise;
      },
    };
    const engine = new TtsEngine(offline);
    const first = engine.generate(request, new AbortController().signal);
    const queuedController = new AbortController();
    const queued = engine.generate({ ...request, generation: 3 }, queuedController.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);

    queuedController.abort();
    await expect(queued).rejects.toThrow("aborted");
    await expect(engine.generate(
      { ...request, generation: 4 },
      new AbortController().signal,
    )).rejects.toBeInstanceOf(TtsOverloadedError);

    results[0].resolve(audio);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);

    const recovered = engine.generate(
      { ...request, generation: 5 },
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    results[1].resolve(audio);
    await expect(recovered).resolves.toMatchObject({ sampleRate: 24_000 });
  });

  it("admits one active and one queued job, then rejects overload", async () => {
    expect(MAX_ADMITTED_TTS_JOBS).toBe(2);
    let active = 0;
    let maxActive = 0;
    const releases: Array<(value: { samples: Float32Array; sampleRate: number }) => void> = [];
    const offline: OfflineTtsLike = {
      sampleRate: 24_000,
      async generateAsync() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const result = deferred<{ samples: Float32Array; sampleRate: number }>();
        releases.push((value) => {
          active -= 1;
          result.resolve(value);
        });
        return result.promise;
      },
    };
    const engine = new TtsEngine(offline);
    const first = engine.generate(request, new AbortController().signal);
    const second = engine.generate({ ...request, generation: 3 }, new AbortController().signal);
    const third = engine.generate({ ...request, generation: 4 }, new AbortController().signal);
    const overload = expect(third).rejects.toBeInstanceOf(TtsOverloadedError);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(1);
    await overload;

    releases.shift()?.(audio);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(1);
    releases.shift()?.(audio);
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);

    const fourth = engine.generate({ ...request, generation: 5 }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(1);
    releases.shift()?.(audio);
    await expect(fourth).resolves.toMatchObject({ sampleRate: 24_000 });
  });
});
