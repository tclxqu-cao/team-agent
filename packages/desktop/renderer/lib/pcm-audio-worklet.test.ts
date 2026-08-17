import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface ProcessorLike {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    messages: unknown[];
  };
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}

function createProcessor(): ProcessorLike {
  let Processor: (new () => ProcessorLike) | undefined;
  class AudioWorkletProcessor {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      messages: [] as unknown[],
      postMessage: (message: unknown) => this.port.messages.push(message),
    };
  }
  const source = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../public/pcm-audio-worklet.js"), "utf8");
  runInNewContext(source, {
    AudioWorkletProcessor,
    Float32Array,
    Math,
    sampleRate: 48_000,
    registerProcessor: (_name: string, constructor: new () => ProcessorLike) => {
      Processor = constructor;
    },
  });
  if (!Processor) throw new Error("worklet did not register its processor");
  return new Processor();
}

function send(processor: ProcessorLike, data: unknown): void {
  processor.port.onmessage?.({ data });
}

describe("pcm-audio-worklet", () => {
  it("waits for 120 ms, resamples, and drains after finish", () => {
    const processor = createProcessor();
    send(processor, { type: "start", generation: 7, sampleRate: 24_000 });
    send(processor, { type: "chunk", generation: 7, samples: new Float32Array(2_879).fill(0.25) });
    let output = new Float32Array(128);
    processor.process([], [[output]]);
    expect(output.every((sample) => sample === 0)).toBe(true);

    send(processor, { type: "chunk", generation: 7, samples: new Float32Array([0.25]) });
    send(processor, { type: "finish", generation: 7 });
    output = new Float32Array(128);
    processor.process([], [[output]]);
    expect(output.every((sample) => sample === 0.25)).toBe(true);

    for (let index = 0; index < 50; index += 1) {
      processor.process([], [[new Float32Array(128)]]);
    }
    expect(processor.port.messages).toContainEqual({ type: "drained", generation: 7 });
  });

  it("rejects PCM beyond the exact one-second ring capacity", () => {
    const processor = createProcessor();
    send(processor, { type: "start", generation: 8, sampleRate: 24_000 });
    send(processor, { type: "chunk", generation: 8, samples: new Float32Array(24_001) });
    expect(processor.port.messages).toEqual([{ type: "overflow", generation: 8 }]);
  });
});
