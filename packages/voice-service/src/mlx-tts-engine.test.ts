import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MlxTtsEngine } from "./mlx-tts-engine";

const here = dirname(fileURLToPath(import.meta.url));
const workerScript = join(here, "../python/mlx_tts_worker.py");

function request(generation = 1) {
  return { sessionId: "voice-test", generation, text: "你好", voice: "Serena", speed: 1 };
}

describe("MlxTtsEngine", () => {
  it("starts a persistent worker and streams bounded PCM", async () => {
    const engine = await MlxTtsEngine.start({
      python: "python3",
      workerScript,
      model: "fake",
      voice: "Serena",
      streamingInterval: 0.32,
      fake: true,
    });
    try {
      const stream = await engine.stream(request(), new AbortController().signal);
      expect(stream).toMatchObject({ sampleRate: 24_000, channels: 1, sampleFormat: "s16le" });
      const chunks: Buffer[] = [];
      for await (const chunk of stream.chunks) chunks.push(chunk);
      await stream.completed;
      expect(chunks).toHaveLength(4);
      expect(chunks.every((chunk) => chunk.length === 1_920)).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it("cancels an active generation and accepts the next generation", async () => {
    const engine = await MlxTtsEngine.start({
      python: "python3",
      workerScript,
      model: "fake",
      voice: "Serena",
      streamingInterval: 0.32,
      fake: true,
    });
    try {
      const controller = new AbortController();
      const first = await engine.stream(request(), controller.signal);
      controller.abort();
      await expect(first.completed).rejects.toMatchObject({ name: "AbortError" });
      const second = await engine.stream(request(2), new AbortController().signal);
      for await (const _chunk of second.chunks) {
        // drain
      }
      await expect(second.completed).resolves.toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it("rejects a missing worker during startup", async () => {
    await expect(MlxTtsEngine.start({
      python: "python3",
      workerScript: `${workerScript}.missing`,
      model: "fake",
      voice: "Serena",
      streamingInterval: 0.32,
      startupTimeoutMs: 2_000,
      fake: true,
    })).rejects.toThrow("exited");
  });

  it("closes the engine and reports a fatal worker failure after readiness", async () => {
    const onFatal = vi.fn();
    const engine = await MlxTtsEngine.start({
      python: "python3",
      workerScript,
      model: "fake",
      voice: "Serena",
      streamingInterval: 0.32,
      fake: true,
      onFatal,
    });
    const failure = new Error("worker crashed");
    (engine as unknown as { failWorker(error: Error): void }).failWorker(failure);

    expect(onFatal).toHaveBeenCalledWith(failure);
    await expect(engine.stream(request(), new AbortController().signal)).rejects.toThrow("closed");
    await engine.close();
  });
});
