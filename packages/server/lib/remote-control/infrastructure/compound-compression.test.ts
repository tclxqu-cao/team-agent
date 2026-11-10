import { expect, it } from 'vitest';
// @ts-expect-error infrastructure ESM
import { createCompoundCompressor, compressCompoundPacket } from './compound-compression.mjs';
import { encodeCompoundTiles, decodeCompoundTiles } from '../../../../core/src/infrastructure/live-view/compound-video-wire.js';

it('compresses negotiated command streams and validates bounded Zstd framing before decompression', async () => {
  const compress = await createCompoundCompressor();
  const message = { version: 1 as const, kind: 'tiles' as const, epoch: 'compressed', revision: 2, sequence: 1, rtpTimestamp: 90000,
    tiles: Array.from({ length: 128 }, (_, index) => ({ cacheId: 1, x: index % 16 * 64, y: Math.floor(index / 16) * 64, width: 64, height: 64 })) };
  const raw = encodeCompoundTiles(message), compressed = compressCompoundPacket(raw, compress);
  expect(String.fromCharCode(...compressed.slice(0, 4))).toBe('ARCZ');
  expect(compressed.length).toBeLessThan(raw.length);
  expect(decodeCompoundTiles(compressed)).toEqual(message);
  const wrong = compressed.slice(); new DataView(wrong.buffer).setUint32(4, 100_000_000);
  expect(() => decodeCompoundTiles(wrong)).toThrow();
  expect(() => decodeCompoundTiles(new Uint8Array([...compressed, 0]))).toThrow();
  for (let at = 8; at < compressed.length; at++) expect(() => decodeCompoundTiles(compressed.subarray(0, at))).toThrow();
  expect(compressCompoundPacket(raw, null)).toBe(raw);
});
