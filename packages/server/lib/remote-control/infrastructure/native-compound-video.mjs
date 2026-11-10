import * as liveView from '@agent/core';

export function normalizeNativeCompoundFrame(input) {
  if (!input || !['frame', 'invalidate', 'sample'].includes(input.kind)
    || !Number.isSafeInteger(input.epoch) || input.epoch < 0) return null;
  const frame = {
    epoch: String(input.epoch), revision: input.revision, timestamp: input.timestamp,
    width: input.width, height: input.height,
    ...(Number.isFinite(input.capturedAt) && input.capturedAt > 0 ? { capturedAt: input.capturedAt } : {}),
  };
  if (!liveView.isCompoundFrame(frame)) return null;
  const rects = Array.isArray(input.rects) && input.rects.length > 0 && input.rects.length <= 32
    && input.rects.every(rect => liveView.isCompoundDirtyRect(rect, frame)) ? input.rects.map(rect => ({
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    })) : undefined;
  return { ...frame, kind: input.kind, ...(rects ? { rects } : {}) };
}

/** Local IPC is still a boundary: never forward arbitrary images or dimensions. */
export function normalizeNativeCompoundSample(input) {
  if (input?.stale) return null;
  const frame = normalizeNativeCompoundFrame(input);
  const limits = liveView.REMOTE_COMPOUND_VIDEO;
  if (!frame || !Array.isArray(input.tiles) || input.tiles.length > limits.maxTiles) throw new Error('Invalid compound capture sample');
  let total = 0;
  const tiles = input.tiles.map(tile => {
    if (typeof tile?.data !== 'string' || tile.data.length > Math.ceil(limits.maxTileBytes / 3) * 4
      || tile.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(tile.data)) throw new Error('Invalid compound PNG payload');
    const image = Buffer.from(tile.data, 'base64');
    total += image.length;
    const descriptor = {
      key: tile.key, x: tile.x, y: tile.y, width: tile.width, height: tile.height,
      entropy: tile.entropy, bytes: image.length,
    };
    if (total > 128 * 1024 || !liveView.isCompoundTile(descriptor, frame)
      || image.length < 24 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || image.toString('ascii', 12, 16) !== 'IHDR'
      || image.readUInt32BE(16) !== tile.width || image.readUInt32BE(20) !== tile.height) throw new Error('Invalid compound PNG dimensions');
    return { ...descriptor, data: tile.data };
  });
  const scroll = input.scroll && liveView.isCompoundScrollCopy(input.scroll, frame) && input.scroll.sourceRevision < frame.revision
    ? { ...input.scroll } : undefined;
  return { frame, tiles, ...(scroll ? { scroll } : {}) };
}
