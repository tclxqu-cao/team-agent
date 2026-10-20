import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { PcmResampler } from "./pcm-resampler";

describe("dictation capture worklet", () => {
  it.each([16_000, 44_100, 48_000])("resamples %i Hz across render quanta and flushes the final short frame", (sampleRate) => {
    const messages: Array<{ type: string; pcm?: ArrayBuffer }> = [];
    let Processor: new () => {
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
      port: { onmessage: (event: { data: { type: string } }) => void };
    };
    const context = vm.createContext({
      sampleRate, Float32Array,
      AudioWorkletProcessor: class { port = { postMessage: (message: { type: string }) => messages.push(message) }; },
      registerProcessor: (_name: string, processor: typeof Processor) => { Processor = processor; },
    });
    vm.runInContext(readFileSync(new URL("../../../../desktop/renderer/public/dictation-audio-worklet.js", import.meta.url), "utf8"), context);
    const processor = new Processor!();
    const fallbackFrames: Float32Array[] = [];
    const fallback = new PcmResampler(sampleRate, (pcm) => fallbackFrames.push(new Float32Array(pcm)));
    const sampleCount = Math.round(sampleRate * 0.35);
    const output = new Float32Array(128).fill(1);
    for (let offset = 0; offset < sampleCount; offset += 128) {
      const channels = [new Float32Array(Math.min(128, sampleCount - offset)).fill(0.5), new Float32Array(Math.min(128, sampleCount - offset))];
      processor.process([channels], [[output]]);
      fallback.push(channels);
    }
    processor.port.onmessage({ data: { type: "flush" } });
    fallback.flush();
    const pcm = messages.filter((message) => message.type === "pcm").map((message) => new Float32Array(message.pcm!));
    expect(pcm.reduce((sum, frame) => sum + frame.length, 0)).toBe(5600);
    expect(pcm.map((frame) => frame.length)).toEqual([1600, 1600, 1600, 800]);
    expect(pcm.every((frame) => frame.every((value) => Math.abs(value - 0.25) < 1e-6))).toBe(true);
    expect(fallbackFrames).toEqual(pcm);
    expect(messages.at(-1)?.type).toBe("flushed");
    expect(output.every((sample) => sample === 0)).toBe(true);
    expect(processor.process([], [])).toBe(false);
  });
});
