import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserCompoundVideo } from "./remote-compound-video.js";
import { encodeCompoundTiles } from "../../../core/src/infrastructure/live-view/compound-video-wire.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAkklEQVR4nO3QQREAAAiAMPuX1hh7yBJwzD43OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0ARtDDsqXe37wAAAAASUVORK5CYII=";
const key = "a".repeat(64);
const tile = { key, x: 0, y: 0, width: 64, height: 64, data: png };
const renderers: BrowserCompoundVideo[] = [];
afterEach(() => { for (const renderer of renderers.splice(0)) renderer.stop(); });

function fixture(decode?: () => Promise<any>, createCanvas?: () => any) {
  const context = { clearRect: vi.fn(), drawImage: vi.fn() };
  const canvas = { style: { visibility: "hidden" }, width: 0, height: 0, getContext: () => context };
  const video = { videoWidth: 128, videoHeight: 64, srcObject: {}, requestVideoFrameCallback: vi.fn(() => 1), cancelVideoFrameCallback: vi.fn() };
  const image = { width: 64, height: 64, source: {}, close: vi.fn() };
  const decodeImage = vi.fn(decode ?? (async () => image));
  const renderer = new BrowserCompoundVideo({ getVideo: () => video as any, getCanvas: () => canvas as any, decodeImage, createCanvas });
  const listeners = new Map<string, (event: any) => void>();
  const peer = { addEventListener: (kind: string, fn: any) => listeners.set(kind, fn), removeEventListener: vi.fn() };
  const channel = { label: 'agentroam.compound.v1', readyState: 'open', bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  renderer.attach(peer as any);
  listeners.get('datachannel')!({ channel });
  const send = (message: Record<string, unknown>) => renderer.receive(JSON.stringify({ version: 1, epoch: 'e', revision: 1, ...message }));
  send({ kind: 'reset', width: 128, height: 64 });
  renderers.push(renderer);
  const batch = (props = {}) => send({ kind: 'tiles', sequence: 1, rtpTimestamp: 90_000, tiles: [tile], ...props });
  const receipts = () => channel.send.mock.calls.map(([data]) => JSON.parse(data));
  return { renderer, canvas, video, image, decodeImage, channel, context, send, batch, receipts };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('browser compound reconstruction', () => {
  it('serially admits all four window batches instead of overwriting pending decodes', async () => {
    const completions: ((value: any) => void)[] = [];
    const f = fixture(() => new Promise(resolve => completions.push(resolve)));
    for (let sequence = 1; sequence <= 4; sequence++) f.batch({ sequence, tiles: [{ ...tile, key: String(sequence).repeat(64) }] });
    expect(f.decodeImage).toHaveBeenCalledOnce();
    for (let index = 0; index < 4; index++) { completions[index](f.image); await settle(); }
    expect(f.receipts().filter(receipt => receipt.kind === 'ack').map(receipt => receipt.sequence)).toEqual([1, 2, 3, 4]);
    expect(f.context.drawImage).toHaveBeenCalledTimes(4);
  });

  it('copies arbitrary-pixel scroll overlap from the previous revision snapshot', async () => {
    const scratch = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) };
    const f = fixture(undefined, () => scratch);
    f.batch({ tiles: [tile, { ...tile, x: 64, data: undefined }] }); await settle();
    f.send({ kind: 'invalidate', revision: 2 });
    f.send({ kind: 'scroll', revision: 2, sequence: 2, rtpTimestamp: 180_000,
      copy: { sourceRevision: 1, sourceX: 17, sourceY: 0, x: 0, y: 0, width: 111, height: 64 } });
    expect(f.context.drawImage).toHaveBeenLastCalledWith(scratch, 17, 0, 111, 64, 0, 0, 111, 64);
    expect(f.receipts()).toContainEqual({ kind: 'ack', epoch: 'e', sequence: 2, ok: true });
    f.renderer.presentFrame(180_000); f.send({ kind: 'frame', revision: 2, rtpTimestamp: 180_000 });
    expect(f.canvas.style.visibility).toBe('visible');
  });

  it('reports actual video presentation separately from cache ACK and answers clock probes', () => {
    const f = fixture(); f.send({ kind: 'ping', t0: 123 });
    expect(f.receipts()).toContainEqual({ kind: 'pong', t0: 123, t1: expect.any(Number), t2: expect.any(Number) });
    f.send({ kind: 'frame', rtpTimestamp: 90_000 }); f.renderer.presentFrame(90_000); f.renderer.presentFrame(90_000);
    const presented = f.receipts().filter(receipt => receipt.kind === 'presented');
    expect(presented).toEqual([{ kind: 'presented', epoch: 'e', rtpTimestamp: 90_000, presentedAt: expect.any(Number) }]);
    expect(f.receipts().some(receipt => receipt.kind === 'ack')).toBe(false);
  });
  const binary = (props = {}) => encodeCompoundTiles({ version: 1, kind: 'tiles', epoch: 'e', revision: 1, sequence: 1,
    rtpTimestamp: 90_000, tiles: [{ cacheId: 1, x: 0, y: 0, width: 64, height: 64, data: png }], ...props });

  it('advertises binary support and decodes raw PNG once for multiple compact references', async () => {
    const f = fixture();
    expect(f.channel).toHaveProperty('binaryType', 'arraybuffer');
    expect(f.receipts()[0]).toMatchObject({ kind: 'ready', formats: ['binary-zstd-v1', 'binary-v1', 'json-v1'] });
    f.renderer.receive(binary({ tiles: [{ cacheId: 1, x: 0, y: 0, width: 64, height: 64, data: png },
      { cacheId: 1, x: 64, y: 0, width: 64, height: 64 }] }).buffer);
    await settle();
    expect(f.decodeImage).toHaveBeenCalledOnce();
    expect(f.decodeImage.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(f.context.drawImage).toHaveBeenCalledTimes(2);
    f.renderer.presentFrame(90_000); f.send({ kind: 'frame', rtpTimestamp: 90_000 });
    expect(f.canvas.style.visibility).toBe('visible');
    f.send({ kind: 'invalidate', revision: 2, rects: [{ x: 0, y: 0, width: 64, height: 64 }] });
    f.renderer.receive(binary({ revision: 2, sequence: 2, tiles: [{ cacheId: 1, x: 0, y: 0, width: 64, height: 64 }] }));
    await settle(); expect(f.decodeImage).toHaveBeenCalledOnce();
    expect(f.receipts()).toContainEqual({ kind: 'ack', epoch: 'e', sequence: 2, ok: true });
  });

  it('rejects forged JSON slot keys and binary slot rebindings without corrupting cache', async () => {
    const f = fixture(); f.renderer.receive(binary()); await settle();
    f.batch({ sequence: 2, binary: true, tiles: [{ ...tile, key: 'slot:1', data: undefined }] }); await settle();
    expect(f.receipts()).toContainEqual({ kind: 'ack', epoch: 'e', sequence: 2, ok: false });
    f.renderer.receive(binary({ sequence: 3 })); await settle();
    expect(f.receipts()).toContainEqual({ kind: 'ack', epoch: 'e', sequence: 3, ok: false });
    expect(f.decodeImage).toHaveBeenCalledOnce();
    f.renderer.receive(binary({ sequence: 4, tiles: [{ cacheId: 2, x: 0, y: 0, width: 64, height: 64 }] })); await settle();
    expect(f.receipts()).toContainEqual({ kind: 'ack', epoch: 'e', sequence: 4, ok: false });
  });

  it('ignores stale binary epochs and cancels a late raw-image decode across reset', async () => {
    let complete!: (image: any) => void;
    const f = fixture(() => new Promise(resolve => { complete = resolve; }));
    f.renderer.receive(binary()); f.send({ kind: 'reset', epoch: 'new', width: 128, height: 64 });
    complete(f.image); await settle();
    f.renderer.receive(binary({ sequence: 2 })); await settle();
    expect(f.image.close).toHaveBeenCalledOnce();
    expect(f.context.drawImage).not.toHaveBeenCalled();
    expect(f.receipts().some(receipt => receipt.kind === 'ack')).toBe(false);
  });

  it('disables enhancement on a truncated binary packet while keeping the video stream', () => {
    const f = fixture(), stream = f.video.srcObject;
    f.renderer.receive(binary().subarray(0, 45));
    expect(f.channel.close).toHaveBeenCalled();
    expect(f.receipts()).toContainEqual({ kind: 'unsupported', version: 1 });
    expect(f.video.srcObject).toBe(stream);
  });

  it('reveals lossless pixels only with a barrier for the exact presented video frame', async () => {
    const f = fixture(); f.batch(); await settle();
    expect(f.context.drawImage).toHaveBeenCalledOnce();
    f.renderer.presentFrame(90_000);
    expect(f.canvas.style.visibility).toBe('hidden');
    f.send({ kind: 'frame', rtpTimestamp: 90_000 });
    expect(f.canvas.style.visibility).toBe('visible');
    f.renderer.presentFrame(180_000);
    expect(f.canvas.style.visibility).toBe('hidden');
    f.send({ kind: 'frame', rtpTimestamp: 90_000 });
    expect(f.canvas.style.visibility).toBe('hidden');
    f.send({ kind: 'frame', rtpTimestamp: 180_000 });
    expect(f.canvas.style.visibility).toBe('visible');
    expect(f.receipts()).toContainEqual({ kind: 'ack', epoch: 'e', sequence: 1, ok: true });
  });

  it('preserves unaffected regions and reuses decoded assets at scrolled coordinates', async () => {
    const f = fixture(); f.batch({ tiles: [tile, { ...tile, x: 64, data: undefined }] }); await settle();
    expect(f.decodeImage).toHaveBeenCalledOnce();
    f.send({ kind: 'invalidate', revision: 2, rects: [{ x: 0, y: 0, width: 64, height: 64 }] });
    expect(f.context.clearRect).toHaveBeenLastCalledWith(0, 0, 64, 64);
    f.renderer.presentFrame(180_000); f.send({ kind: 'frame', revision: 2, rtpTimestamp: 180_000 });
    expect(f.canvas.style.visibility).toBe('visible');
    f.batch({ revision: 2, sequence: 2, rtpTimestamp: 180_000, tiles: [{ ...tile, data: undefined }] }); await settle();
    expect(f.decodeImage).toHaveBeenCalledOnce();
    expect(f.image.close).not.toHaveBeenCalled();
  });

  it('cancels a late image decode after invalidation without acknowledging or painting it', async () => {
    let complete!: (image: any) => void;
    const f = fixture(() => new Promise(resolve => { complete = resolve; }));
    f.batch(); f.send({ kind: 'invalidate', revision: 2 });
    complete(f.image); await settle();
    expect(f.context.drawImage).not.toHaveBeenCalled();
    expect(f.image.close).toHaveBeenCalledOnce();
    expect(f.receipts().some(receipt => receipt.kind === 'ack')).toBe(false);
    expect(f.canvas.style.visibility).toBe('hidden');
  });

  it('does not display a patch ahead of its source video and handles the 32-bit RTP wrap', async () => {
    const f = fixture(); f.batch({ rtpTimestamp: 0xffff_fff0 }); await settle();
    f.renderer.presentFrame(0xffff_ffe0); f.send({ kind: 'frame', rtpTimestamp: 0xffff_ffe0 });
    expect(f.canvas.style.visibility).toBe('hidden');
    f.renderer.presentFrame(10); f.send({ kind: 'frame', rtpTimestamp: 10 });
    expect(f.canvas.style.visibility).toBe('visible');
  });

  it('releases cached images and rejects old-epoch data across capture reset', async () => {
    const f = fixture(); f.batch(); await settle();
    f.send({ kind: 'reset', epoch: 'new', width: 128, height: 64 });
    expect(f.image.close).toHaveBeenCalledOnce();
    f.batch({ sequence: 2 }); await settle();
    expect(f.context.drawImage).toHaveBeenCalledOnce();
    expect(f.canvas.style.visibility).toBe('hidden');
  });

  it('checks PNG dimensions before decoding and rejects missing cache references', async () => {
    const f = fixture(); f.batch({ tiles: [{ ...tile, width: 32 }] }); await settle();
    expect(f.decodeImage).not.toHaveBeenCalled();
    expect(f.receipts()).toContainEqual({ kind: 'ack', epoch: 'e', sequence: 1, ok: false });
    f.batch({ sequence: 2, tiles: [{ ...tile, data: undefined }] }); await settle();
    expect(f.receipts()).toContainEqual({ kind: 'ack', epoch: 'e', sequence: 2, ok: false });
  });

  it('falls back when RTP metadata or bounded geometry is unavailable, keeping H264 intact', () => {
    const f = fixture(); const stream = f.video.srcObject;
    f.renderer.presentFrame(undefined);
    expect(f.receipts()).toContainEqual({ kind: 'unsupported', version: 1 });
    expect(f.channel.close).toHaveBeenCalled();
    expect(f.video.srcObject).toBe(stream);
    const invalid = fixture(); invalid.send({ kind: 'reset', width: 100_000, height: 100_000 });
    expect(invalid.channel.close).toHaveBeenCalled();
  });

  it('closes images and callbacks on teardown and ignores subsequent messages', async () => {
    const f = fixture(); f.batch(); await settle(); f.renderer.stop();
    expect(f.image.close).toHaveBeenCalledOnce();
    expect(f.video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    f.batch({ sequence: 2 }); await settle();
    expect(f.context.drawImage).toHaveBeenCalledOnce();
  });
});
