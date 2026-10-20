import { describe, expect, it, vi } from "vitest";
import { decodeS16Le, PcmStreamPlayer } from "./pcm-stream-player";

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

function fixture(blockModule = false, withFallback = false) {
  const port = new FakePort();
  let releaseModule: (() => void) | undefined;
  const addModule = vi.fn(() => blockModule
    ? new Promise<void>((resolve) => { releaseModule = resolve; })
    : Promise.resolve());
  const context = {
    destination: {} as AudioDestinationNode,
    state: "suspended",
    audioWorklet: { addModule },
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const node = { port, connect: vi.fn(), disconnect: vi.fn() };
  const fallbackPort = new FakePort();
  const fallback = { port: fallbackPort, connect: vi.fn(), disconnect: vi.fn() };
  const createFallbackNode = withFallback ? vi.fn(() => fallback) : undefined;
  const api = {
    ttsStop: vi.fn(async () => ({ ok: true })),
    ttsPlaybackEnded: vi.fn(async () => ({ ok: true })),
  };
  const player = new PcmStreamPlayer(api, {
    createContext: () => context,
    createNode: () => node,
    workletUrl: "worklet.js",
    createFallbackNode,
    workletTimeoutMs: 100,
  });
  return { player, port, api, context, fallbackPort, createFallbackNode, releaseModule: () => releaseModule?.() };
}

const metadata = {
  sessionId: "voice-1",
  generation: 4,
  sampleRate: 24_000 as const,
  channels: 1 as const,
  sampleFormat: "s16le" as const,
};

describe("decodeS16Le", () => {
  it("converts signed little-endian samples into normalized floats", () => {
    const decoded = decodeS16Le(Buffer.from([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]));
    expect(Array.from(decoded)).toEqual([-1, 0, 32767 / 32768]);
  });
});

describe("PcmStreamPlayer", () => {
  it("falls back when worklet initialization never settles and ignores a late load", async () => {
    vi.useFakeTimers();
    try {
      const { player, fallbackPort, port, createFallbackNode, releaseModule } = fixture(true, true);
      const ready = player.prepare();
      await vi.advanceTimersByTimeAsync(100);
      await ready;
      player.start(metadata);
      await player.prepare();
      releaseModule();
      await Promise.resolve();
      expect(createFallbackNode).toHaveBeenCalledOnce();
      expect(fallbackPort.messages).toContainEqual({ type: "start", generation: 4, sampleRate: 24_000 });
      expect(port.messages).toEqual([]);
      player.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("falls back when the browser rejects the worklet module", async () => {
    const { player, context, createFallbackNode } = fixture(false, true);
    context.audioWorklet.addModule.mockImplementationOnce(() => Promise.reject(new Error("unsupported")));
    await player.prepare();
    expect(createFallbackNode).toHaveBeenCalledOnce();
    player.dispose();
  });

  it("does not create a playback node after disposal during initialization", async () => {
    const { player, createFallbackNode, releaseModule } = fixture(true, true);
    const ready = player.prepare();
    player.dispose();
    releaseModule();
    await ready;
    expect(createFallbackNode).not.toHaveBeenCalled();
  });

  it("unlocks audio synchronously in the tap before waiting for the worklet", async () => {
    const { player, context, releaseModule } = fixture(true);
    const ready = player.prepare();
    expect(context.resume).toHaveBeenCalledOnce();
    releaseModule();
    await ready;
    player.dispose();
  });
  it("queues early PCM, transfers it after start, and acknowledges drain", async () => {
    const { player, port, api, releaseModule } = fixture(true);
    player.start(metadata);
    player.enqueue(4, Buffer.from([0x00, 0x80, 0xff, 0x7f]));
    player.finish(4);
    expect(port.messages).toEqual([]);

    releaseModule();
    await vi.waitFor(() => expect(port.messages).toHaveLength(3));
    expect(port.messages).toEqual([
      { type: "start", generation: 4, sampleRate: 24_000 },
      expect.objectContaining({ type: "chunk", generation: 4 }),
      { type: "finish", generation: 4 },
    ]);
    port.emit({ type: "drained", generation: 4 });
    expect(api.ttsPlaybackEnded).toHaveBeenCalledWith(4);
  });

  it("ignores stale chunks and flushes the active generation immediately", async () => {
    const { player, port, api } = fixture();
    player.start(metadata);
    await player.prepare();
    player.enqueue(3, Buffer.from([0, 0]));
    player.flush(4);
    expect(port.messages).toContainEqual({ type: "flush", generation: 4 });
    expect(api.ttsPlaybackEnded).toHaveBeenCalledWith(4);
  });

  it("bounds PCM queued while the worklet loads to one second", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { player, api } = fixture(true);
    player.start(metadata);
    player.enqueue(4, Buffer.alloc(24_000 * 2));
    expect(api.ttsStop).not.toHaveBeenCalled();
    player.enqueue(4, Buffer.alloc(2));
    expect(api.ttsStop).toHaveBeenCalledOnce();
    expect(api.ttsPlaybackEnded).toHaveBeenCalledWith(4);
    log.mockRestore();
  });

  it("stops synthesis when the AudioWorklet reports overflow", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { player, port, api } = fixture();
    player.start(metadata);
    await player.prepare();
    port.emit({ type: "overflow", generation: 4 });
    expect(api.ttsStop).toHaveBeenCalledOnce();
    expect(api.ttsPlaybackEnded).toHaveBeenCalledWith(4);
    log.mockRestore();
  });
});
