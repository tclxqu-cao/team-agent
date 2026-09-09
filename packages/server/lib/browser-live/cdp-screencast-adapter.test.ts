import { describe, expect, it, vi } from "vitest";
import { BrowserLiveCapabilityError, CdpScreencastAdapter, EgoScreencastAdapter } from "./cdp-screencast-adapter.mjs";

describe("CdpScreencastAdapter", () => {
  it("streams and acknowledges direct CDP frames", async () => {
    const sends: Array<[string, unknown]> = [];
    let reads = 0;
    const adapter = new CdpScreencastAdapter({
      send: async (method, params) => { sends.push([method, params]); },
      readEvents: async () => reads++ === 0
        ? { cursor: 1, events: [] }
        : { cursor: 2, events: [{ method: "Page.screencastFrame", params: { sessionId: 7, data: "jpeg" } }] },
      pageState: async () => ({ width: 800, height: 600, title: "Page", url: "https://example.com" }),
      firstFrameTimeoutMs: 100,
    });
    const frames: unknown[] = [];
    await expect(adapter.start(async (frame) => { frames.push(frame); await adapter.stop(); })).resolves.toBeUndefined();
    expect(frames).toEqual([expect.objectContaining({ data: "jpeg", title: "Page" })]);
    expect(sends.map(([method]) => method)).toContain("Page.screencastFrameAck");
  });

  it("fails closed when a runtime filters screencast events", async () => {
    let now = 0;
    const adapter = new CdpScreencastAdapter({
      send: vi.fn().mockResolvedValue(undefined),
      readEvents: async () => {
        now += 20;
        return [];
      },
      pageState: async () => ({ width: 800, height: 600, title: "Page", url: "https://example.com" }),
      firstFrameTimeoutMs: 50,
      now: () => now,
    });
    await expect(adapter.start(vi.fn())).rejects.toBeInstanceOf(BrowserLiveCapabilityError);
  });

  it("uses Input.insertText for composition-friendly text input", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const adapter = new CdpScreencastAdapter({
      send,
      readEvents: vi.fn(),
      pageState: async () => ({ width: 800, height: 600 }),
    });
    await adapter.dispatchInput({ kind: "key", action: "down", key: "", code: "", text: "中文", modifiers: [] });
    expect(send).toHaveBeenCalledWith("Input.insertText", { text: "中文" });
  });

  it("adapts frame delivery between two and five FPS under backpressure", async () => {
    let now = 0;
    let reads = 0;
    const adapter = new CdpScreencastAdapter({
      send: vi.fn().mockResolvedValue(undefined),
      readEvents: async () => {
        if (reads++ === 0) return [];
        now += 1_000;
        return [{ method: "Page.screencastFrame", params: { sessionId: reads, data: "jpeg" } }];
      },
      pageState: async () => ({ width: 800, height: 600 }),
      now: () => now,
    });
    let delivered = 0;
    await adapter.start(async () => {
      delivered += 1;
      if (delivered === 3) await adapter.stop();
      return { accepted: false, dropped: "backpressure" };
    });

    expect(adapter.targetFps).toBe(2);
  });

  it("stops the CDP screencast idempotently", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const adapter = new CdpScreencastAdapter({
      send,
      readEvents: vi.fn(),
      pageState: vi.fn(),
    });

    await Promise.all([adapter.stop(), adapter.stop()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Page.stopScreencast");
  });
});

describe("EgoScreencastAdapter", () => {
  it("consumes ego-browser's push subscription without reading the generic event queue", async () => {
    let subscriptionOptions: any;
    const dispose = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const adapter = new EgoScreencastAdapter({
      send,
      subscribe: async (options) => {
        subscriptionOptions = options;
        return { dispose };
      },
      pageState: async () => ({ width: 800, height: 600, title: "Ego", url: "https://example.com" }),
      firstFrameTimeoutMs: 100,
    });
    const frames: any[] = [];
    const running = adapter.start(async (frame) => {
      frames.push(frame);
      return { accepted: true };
    });
    await vi.waitFor(() => expect(subscriptionOptions).toBeTruthy());

    await subscriptionOptions.onFrame({ data: "jpeg", sessionId: 7, timestamp: 1 });
    await adapter.stop();
    await expect(running).resolves.toBeUndefined();

    expect(subscriptionOptions).toEqual(expect.objectContaining({
      size: { width: 1440, height: 900 },
      quality: 70,
      everyNthFrame: 1,
      onFrame: expect.any(Function),
    }));
    expect(frames).toEqual([expect.objectContaining({ data: "jpeg", title: "Ego" })]);
    expect(send).not.toHaveBeenCalledWith("Page.screencastFrameAck", expect.anything());
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the ego-browser subscription produces no first frame", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const adapter = new EgoScreencastAdapter({
      send: vi.fn(),
      subscribe: async () => ({ dispose }),
      pageState: async () => ({ width: 800, height: 600 }),
      firstFrameTimeoutMs: 5,
    });

    await expect(adapter.start(vi.fn())).rejects.toBeInstanceOf(BrowserLiveCapabilityError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps text input on the shared CDP input path", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const adapter = new EgoScreencastAdapter({
      send,
      subscribe: vi.fn(),
      pageState: async () => ({ width: 800, height: 600 }),
    });

    await adapter.dispatchInput({ kind: "key", action: "down", key: "", code: "", text: "中文", modifiers: [] });
    expect(send).toHaveBeenCalledWith("Input.insertText", { text: "中文" });
  });
});
