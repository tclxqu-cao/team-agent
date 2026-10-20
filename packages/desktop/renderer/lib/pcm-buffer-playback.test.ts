import { describe, expect, it, vi } from "vitest";
import { createBufferPlaybackNode } from "./pcm-buffer-playback";

function fixture() {
  const sources: Array<{
    buffer: AudioBuffer | null;
    onended: (() => void) | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const context = {
    currentTime: 10,
    destination: {} as AudioDestinationNode,
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate, copyToChannel: vi.fn(),
    })),
    createBufferSource: () => {
      const source = { buffer: null, onended: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      sources.push(source);
      return source;
    },
  };
  const node = createBufferPlaybackNode(context as unknown as AudioContext);
  const events: unknown[] = [];
  node.port.onmessage = ({ data }) => events.push(data);
  node.connect(context.destination);
  node.port.postMessage({ type: "start", generation: 4, sampleRate: 24_000 });
  return { node, sources, context, events };
}

describe("buffer PCM playback", () => {
  it("schedules continuous source-rate buffers and drains only after audible playback ends", async () => {
    const { node, sources, context, events } = fixture();
    const samples = new Float32Array(2400).fill(0.5);
    node.port.postMessage({ type: "chunk", generation: 4, samples });
    node.port.postMessage({ type: "chunk", generation: 4, samples });
    node.port.postMessage({ type: "finish", generation: 4 });
    expect(context.createBuffer).toHaveBeenCalledWith(1, 2400, 24_000);
    expect(sources[0].start).toHaveBeenCalledWith(10.02);
    expect(sources[1].start).toHaveBeenCalledWith(10.12);
    sources[0].onended?.();
    await Promise.resolve();
    expect(events).toEqual([]);
    sources[1].onended?.();
    await Promise.resolve();
    expect(events).toEqual([{ type: "drained", generation: 4 }]);
  });

  it("stops scheduled audio immediately and isolates the next generation from stale PCM", async () => {
    const { node, sources, events } = fixture();
    node.port.postMessage({ type: "chunk", generation: 4, samples: new Float32Array(2400) });
    node.port.postMessage({ type: "flush", generation: 4 });
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(sources[0].disconnect).toHaveBeenCalledOnce();
    expect(sources[0].onended).toBeNull();
    node.port.postMessage({ type: "start", generation: 5, sampleRate: 24_000 });
    node.port.postMessage({ type: "chunk", generation: 4, samples: new Float32Array(2400) });
    node.port.postMessage({ type: "finish", generation: 5 });
    await Promise.resolve();
    expect(sources).toHaveLength(1);
    expect(events).toEqual([{ type: "stopped", generation: 4 }, { type: "drained", generation: 5 }]);
  });

  it("bounds scheduled PCM to one second and cancels audio when that bound is exceeded", async () => {
    const { node, sources, events } = fixture();
    node.port.postMessage({ type: "chunk", generation: 4, samples: new Float32Array(24_000) });
    node.port.postMessage({ type: "chunk", generation: 4, samples: new Float32Array(1) });
    await Promise.resolve();
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: "overflow", generation: 4 }]);
  });
});
