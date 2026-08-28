import { describe, expect, it, vi } from "vitest";
import { BoundedAsyncQueue, encodeFrame, FrameDecoder } from "./framed-process";

describe("framed process protocol", () => {
  it("decodes fragmented and coalesced JSON and PCM frames", () => {
    const json = encodeFrame(1, Buffer.from('{"type":"ready"}'));
    const pcm = encodeFrame(2, Buffer.from([0, 1, 2, 3]));
    const decoder = new FrameDecoder();
    expect(decoder.push(json.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([json.subarray(3), pcm]))).toEqual([
      { kind: "json", payload: Buffer.from('{"type":"ready"}') },
      { kind: "pcm", payload: Buffer.from([0, 1, 2, 3]) },
    ]);
  });

  it("keeps coalesced frames buffered when a caller limits each drain", () => {
    const first = encodeFrame(2, Buffer.from([1, 0]));
    const second = encodeFrame(2, Buffer.from([2, 0]));
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.concat([first, second]), 1)).toEqual([
      { kind: "pcm", payload: Buffer.from([1, 0]) },
    ]);
    expect(decoder.push(Buffer.alloc(0), 1)).toEqual([
      { kind: "pcm", payload: Buffer.from([2, 0]) },
    ]);
  });

  it("rejects unknown frame kinds and oversized payload declarations", () => {
    const unknown = Buffer.alloc(5);
    unknown[0] = 3;
    expect(() => new FrameDecoder().push(unknown)).toThrow("unknown frame kind");
    const oversized = Buffer.alloc(5);
    oversized[0] = 1;
    oversized.writeUInt32BE(1024 * 1024 + 1, 1);
    expect(() => new FrameDecoder().push(oversized)).toThrow("exceeds 1 MiB");
  });
});
describe("BoundedAsyncQueue", () => {
  it("applies pressure at capacity and resumes after consumption", async () => {
    const onFull = vi.fn();
    const onSpace = vi.fn();
    const queue = new BoundedAsyncQueue<number>(2, onFull, onSpace);
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.isFull).toBe(true);
    expect(queue.push(3)).toBe(false);
    expect(onFull).toHaveBeenCalledOnce();
    await expect(queue[Symbol.asyncIterator]().next()).resolves.toEqual({ value: 1, done: false });
    expect(queue.isFull).toBe(false);
    expect(onSpace).toHaveBeenCalledOnce();
    queue.close();
    await expect(queue[Symbol.asyncIterator]().next()).resolves.toEqual({ value: 2, done: false });
    await expect(queue[Symbol.asyncIterator]().next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("propagates close errors to pending consumers", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    const pending = queue[Symbol.asyncIterator]().next();
    queue.close(new Error("failed"));
    await expect(pending).rejects.toThrow("failed");
  });
});
