import { describe, expect, it, vi } from "vitest";
import { ViewerFrameFlow } from "./viewer-frame-flow.mjs";
const frame = (sequence: number) => ({ channelId: 1, sequence, bytes: new Uint8Array(32) });
describe("viewer frame flow", () => {
  it("pipelines ACK-delayed frames within both frame and byte limits", () => {
    const send = vi.fn();
    const flow = new ViewerFrameFlow(send, () => true, { maxFrames: 3, maxBytes: 64 });
    flow.reset(true);
    for (let n = 1; n <= 100; n++) flow.offer(frame(n));
    expect(send.mock.calls.map(([f]) => f.sequence)).toEqual([1, 2]);
    flow.ack(1, 2);
    expect(send.mock.calls.map(([f]) => f.sequence)).toEqual([1, 2, 100]);
    flow.ack(1, 2);
    flow.offer(frame(101));
    expect(send).toHaveBeenCalledTimes(3);
    flow.ack(1, 1);
    expect(send.mock.calls.at(-1)?.[0].sequence).toBe(101);
  });
  it("bounds a slow viewer to one image and sends only the newest after acknowledgement", () => {
    const send = vi.fn();
    const flow = new ViewerFrameFlow(send);
    flow.reset(true);
    for (let n = 1; n <= 100; n++) flow.offer(frame(n));
    expect(send.mock.calls.map(([f]) => f.sequence)).toEqual([1]);
    flow.ack(1, 1);
    expect(send.mock.calls.map(([f]) => f.sequence)).toEqual([1, 100]);
    flow.ack(1, 1);
    flow.offer(frame(101));
    expect(send).toHaveBeenCalledTimes(2);
    flow.ack(1, 100);
    expect(send.mock.calls.at(-1)?.[0].sequence).toBe(101);
  });
  it("does not queue binary frames behind an already congested socket", () => {
    const send = vi.fn(); let writable = false;
    const flow = new ViewerFrameFlow(send, () => writable);
    flow.offer(frame(1)); flow.offer(frame(2));
    expect(send).not.toHaveBeenCalled();
    writable = true; flow.offer(frame(3));
    expect(send.mock.calls.map(([f]) => f.sequence)).toEqual([3]);
  });
  it("drops pending frames when unwatching and rejects stale channel acknowledgements", () => {
    const send = vi.fn(); const flow = new ViewerFrameFlow(send);
    flow.reset(true); flow.offer(frame(1)); flow.offer(frame(2));
    flow.ack(2, 1); expect(send).toHaveBeenCalledTimes(1);
    flow.reset(true); flow.ack(1, 1); expect(send).toHaveBeenCalledTimes(1);
    flow.offer(frame(3)); expect(send.mock.calls.at(-1)?.[0].sequence).toBe(3);
  });
});
