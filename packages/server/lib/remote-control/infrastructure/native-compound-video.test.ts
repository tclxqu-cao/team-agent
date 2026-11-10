import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error gateway ESM
import { normalizeNativeCompoundFrame, normalizeNativeCompoundSample } from './native-compound-video.mjs';
// @ts-expect-error gateway ESM
import { NativeVideoEncoder } from './native-video-encoder.mjs';
vi.mock('@agent/core', async original => ({ ...await original<Record<string, unknown>>(), ...await import('../../../../core/src/domain/live-view/index.js'), ...await import('../../../../core/src/domain/live-view/remote-compound-video.js'), ...await import('../../../../core/src/domain/live-view/remote-compound-budget.js'), ...await import('../../../../core/src/domain/live-view/remote-video-encode-admission.js') }));

export const whitePng = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAkklEQVR4nO3QQREAAAiAMPuX1hh7yBJwzD43OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0ARtDDsqXe37wAAAAASUVORK5CYII=";
const tile = { key: 'a'.repeat(64), x: 0, y: 0, width: 64, height: 64, entropy: 1, data: whitePng };
const sample = { kind: 'sample', epoch: 1, revision: 2, timestamp: 1, width: 128, height: 64, tiles: [tile] };

describe('native compound boundary', () => {
  it('passes the domain classification threshold through the native port', async () => {
    const helper = { request: vi.fn(async () => sample) };
    await new NativeVideoEncoder({ helper }).sampleCompound(10_000);
    expect(helper.request).toHaveBeenCalledWith({ op: 'compound-sample', maxBytes: 10_000, maxEntropy: 6.3, priorityIndices: [] });
  });
  it('normalizes bounded frames, dirty regions and PNG samples', () => {
    expect(normalizeNativeCompoundFrame({ ...sample, kind: 'invalidate', rects: [{ x: 0, y: 0, width: 64, height: 64 }] }))
      .toMatchObject({ epoch: '1', rects: [{ x: 0, y: 0, width: 64, height: 64 }] });
    expect(normalizeNativeCompoundSample(sample)).toMatchObject({ frame: { epoch: '1' }, tiles: [{ bytes: 203 }] });
    expect(normalizeNativeCompoundSample({ stale: true })).toBeNull();
  });
  it.each([
    { ...tile, data: 'javascript:invalid' },
    { ...tile, width: 32 },
    { ...tile, x: 128 },
    { ...tile, entropy: 25 },
    { ...tile, key: 'bad' },
  ])('rejects malformed or mismatched payloads', invalid => {
    expect(() => normalizeNativeCompoundSample({ ...sample, tiles: [invalid] })).toThrow();
  });
  it('bounds decoded canvas size and candidate count', () => {
    expect(normalizeNativeCompoundFrame({ ...sample, width: 16_384 })).toBeNull();
    expect(() => normalizeNativeCompoundSample({ ...sample, tiles: Array(129).fill(tile) })).toThrow();
    expect(normalizeNativeCompoundFrame({ ...sample, epoch: -1 })).toBeNull();
  });
});
