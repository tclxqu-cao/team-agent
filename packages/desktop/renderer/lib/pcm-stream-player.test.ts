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

function fixture(blockModule = false) {
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
  const api = {
    ttsStop: vi.fn(async () => ({ ok: true })),
    ttsPlaybackEnded: vi.fn(async () => ({ ok: true })),
  };
  const player = new PcmStreamPlayer(api, {
    createContext: () => context,
    createNode: () => node,
    workletUrl: "worklet.js",
  });
  return { player, port, api, context, releaseModule: () => releaseModule?.() };
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
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
    port.emit({ type: "overflow", generation: 4 });
    expect(api.ttsStop).toHaveBeenCalledOnce();
    expect(api.ttsPlaybackEnded).toHaveBeenCalledWith(4);
    log.mockRestore();
  });
});
