import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error gateway ESM
import { CompoundVideoSession } from './compound-video-session.mjs';
import { encodeCompoundTiles, decodeCompoundTiles, compoundTileEncodingCost } from '../../../../core/src/infrastructure/live-view/compound-video-wire.js';
vi.mock('@agent/core', async original => ({ ...await original<Record<string, unknown>>(), ...await import('../../../../core/src/domain/live-view/index.js'), ...await import('../../../../core/src/domain/live-view/remote-compound-video.js'), ...await import('../../../../core/src/domain/live-view/remote-compound-budget.js'), ...await import('../../../../core/src/domain/live-view/remote-video-encode-admission.js') }));

const frame = { epoch: '1', revision: 1, timestamp: 1, width: 128, height: 64, kind: 'frame' };
const tile = { key: 'a'.repeat(64), x: 0, y: 0, width: 64, height: 64, entropy: 1, bytes: 203, data: 'test-payload' };
function fixture() {
  let now = 0;
  let listener: (data: any) => void = () => {};
  const unsubscribe = vi.fn();
  const encoder = {
    onCompound: vi.fn(fn => { listener = fn; return unsubscribe; }),
    enableCompound: vi.fn(async () => {}), sampleCompound: vi.fn(async () => ({ frame, tiles: [tile] })),
  };
  const sent: any[] = [];
  const transport = { canSendCompound: vi.fn(() => true), sendCompound: vi.fn(message => { sent.push(message); return true; }) };
  const allocation = vi.fn();
  const session = new CompoundVideoSession({ encoder, transport, onAllocationChanged: allocation,
    clock: { now: () => now, schedule: vi.fn(() => 1), cancel: vi.fn() },
  });
  return { session, encoder, transport, sent, unsubscribe, allocation,
    advance: (ms = 250) => { now += ms; }, capture: (data: any = frame) => listener(data),
    ready: async () => {
      session.handleMessage({ kind: 'ready', version: 1 });
      await session.start(); now += 250;
      listener(frame); session.frameSent({ timestamp: 1 });
    },
  };
}

describe('compound video application coordinator', () => {
  it('stops native scans after all repairs are ACKed, keeps QoE alive and wakes on new damage', async () => {
    const f = fixture();
    try {
      await f.ready(); f.session.handleMessage({ kind: 'ready', version: 1, features: ['window-v1', 'qoe-v1'] });
      f.encoder.sampleCompound.mockResolvedValue({ frame, tiles: [tile, { ...tile, x: 64 }] });
      f.advance(); await f.session.tick();
      const batch = f.sent.filter(message => message.kind === 'tiles').at(-1);
      const calls = f.encoder.sampleCompound.mock.calls.length;
      f.advance(); await f.session.tick(); // all debt is in flight, even with window capacity
      expect(f.encoder.sampleCompound).toHaveBeenCalledTimes(calls);
      f.session.handleMessage({ kind: 'ack', epoch: batch.epoch, sequence: batch.sequence, ok: true });
      for (let n = 0; n < 4; n++) { f.advance(5000); await f.session.tick(); }
      expect(f.encoder.sampleCompound).toHaveBeenCalledTimes(calls);
      expect(f.sent.filter(message => message.kind === 'ping').length).toBeGreaterThan(1);
      const next = { ...frame, revision: 2, timestamp: 2, rects: [{ x: 64, y: 0, width: 64, height: 64 }] };
      f.capture(next); f.session.frameSent(next);
      f.encoder.sampleCompound.mockResolvedValue({ frame: next, tiles: [{ ...tile, x: 64 }] });
      f.advance(); await f.session.tick();
      expect(f.encoder.sampleCompound).toHaveBeenLastCalledWith(expect.any(Number), expect.objectContaining({ selectedOnly: true, priorityIndices: [1] }));
    } finally { await f.session.stop(); }
  });

  it('keeps probing unresolved high-entropy debt after the desktop becomes idle', async () => {
    const f = fixture();
    try {
      await f.ready(); f.encoder.sampleCompound.mockResolvedValue({ frame, tiles: [] });
      f.advance(); await f.session.tick();
      expect(f.encoder.sampleCompound).toHaveBeenLastCalledWith(expect.any(Number), expect.objectContaining({ maxEntropy: 6.3 }));
      f.session.observe({ content: { activity: 'idle' } }); f.advance(2000); await f.session.tick();
      expect(f.encoder.sampleCompound).toHaveBeenLastCalledWith(expect.any(Number), expect.objectContaining({ maxEntropy: 24, priorityIndices: [0, 1] }));
    } finally { await f.session.stop(); }
  });
  it('serializes cursor activation and restore across pause/resume and ignores late native events', async () => {
    const f = fixture(); let listener!: (message: any) => void;
    const enable = vi.fn(async (_enabled: boolean) => {}), sendCursor = vi.fn(() => true), unsubscribe = vi.fn();
    Object.assign(f.encoder, { enableCursor: enable, onCursor: (fn: any) => { listener = fn; return unsubscribe; } });
    Object.assign(f.transport, { sendCursor });
    try {
      await f.ready(); f.session.handleMessage({ kind: 'ready', version: 1, features: ['cursor-v1'] });
      await f.session.cursorActions; expect(enable).toHaveBeenLastCalledWith(true);
      listener({ sequence: 1, x: .5, y: .5, visible: true, active: true });
      expect(sendCursor).toHaveBeenCalledOnce();
      f.session.pause(); const old = listener;
      old({ sequence: 2, x: .2, y: .2, visible: true, active: true });
      expect(sendCursor).toHaveBeenCalledTimes(2); // one state plus explicit hide
      f.session.resume(); await f.session.cursorActions;
      expect(enable.mock.calls.map(([enabled]) => enabled)).toEqual([true, false, true]);
      listener({ sequence: 1, x: .5, y: .5, visible: true, active: true });
      expect(sendCursor.mock.calls.at(-1)?.[0].sequence).toBe(3);
      f.session.handleMessage({ kind: 'cursor-closed' }); await f.session.cursorActions;
      expect(enable).toHaveBeenLastCalledWith(false);
    } finally { await f.session.stop(); }
  });
  it('uses an ACK-independent bounded window without reusing unconfirmed cache contents', async () => {
    const f = fixture();
    try {
      await f.ready(); f.session.handleMessage({ kind: 'ready', version: 1, features: ['window-v1'] });
      f.session.observe({ network: { rttMs: 1000 } });
      const wide = { ...frame, width: 512 }; f.capture(wide);
      for (let index = 0; index < 5; index++) {
        f.encoder.sampleCompound.mockResolvedValueOnce({ frame: wide, tiles: [{ ...tile, x: index * 64, key: (index + 1).toString(16).repeat(64) }] });
        f.advance(); await f.session.tick();
      }
      expect(f.session.pendingBatches.size).toBe(4);
      const batches = f.sent.filter(message => message.kind === 'tiles');
      expect(batches).toHaveLength(4);
      expect(batches.every(batch => batch.tiles[0].data !== undefined)).toBe(true);
      expect(new Set(batches.map(batch => batch.tiles[0].cacheId)).size).toBe(4);
      f.session.handleMessage({ kind: 'ack', epoch: batches[1].epoch, sequence: batches[1].sequence, ok: true });
      expect(f.session.pendingBatches.size).toBe(3);
    } finally { await f.session.stop(); }
  });

  it('waits for scroll ACK before suppressing repairs inside fully copied sharp regions', async () => {
    const f = fixture();
    const large = { ...frame, height: 128 };
    const tiles = [tile, { ...tile, x: 64 }, { ...tile, y: 64 }, { ...tile, x: 64, y: 64 }];
    try {
      await f.ready(); f.session.handleMessage({ kind: 'ready', version: 1, features: ['scroll-v1'] });
      f.capture(large); f.encoder.sampleCompound.mockResolvedValue({ frame: large, tiles });
      f.advance(); await f.session.tick();
      const first = f.sent.filter(message => message.kind === 'tiles').at(-1);
      f.session.handleMessage({ kind: 'ack', epoch: first.epoch, sequence: first.sequence, ok: true });
      const next = { ...large, revision: 2, timestamp: 2 };
      f.capture(next); f.session.frameSent(next);
      f.encoder.sampleCompound.mockResolvedValue({ frame: next, tiles, scroll: { sourceRevision: 1, sourceX: 0, sourceY: 17, x: 0, y: 0, width: 128, height: 111 } });
      f.advance(); await f.session.tick();
      const copy = f.sent.find(message => message.kind === 'scroll');
      expect(copy.copy.sourceY).toBe(17);
      f.session.handleMessage({ kind: 'ack', epoch: copy.epoch, sequence: copy.sequence, ok: true });
      f.advance(); await f.session.tick();
      const repair = f.sent.filter(message => message.kind === 'tiles').at(-1);
      expect(repair.tiles).toHaveLength(2); expect(repair.tiles.every((entry: any) => entry.y === 64)).toBe(true);
    } finally { await f.session.stop(); }
  });

  it('handles early receiver readiness, correlates delivered frames and requires an exact acknowledgement before reuse', async () => {
    const f = fixture();
    try {
      await f.ready();
      expect(f.sent).toContainEqual(expect.objectContaining({ kind: 'frame', rtpTimestamp: 90_000, revision: 1 }));
      f.advance(); await f.session.tick();
      const batch = f.sent.find(message => message.kind === 'tiles');
      expect(batch.tiles[0].data).toBe('test-payload');
      f.advance(); await f.session.tick();
      expect(f.encoder.sampleCompound).toHaveBeenCalledTimes(1);
      f.session.handleMessage({ kind: 'ack', epoch: 'stale', sequence: batch.sequence, ok: true });
      f.advance(); await f.session.tick();
      expect(f.encoder.sampleCompound).toHaveBeenCalledTimes(1);
      f.session.handleMessage({ kind: 'ack', epoch: batch.epoch, sequence: batch.sequence, ok: true });
      f.capture({ ...frame, kind: 'invalidate', revision: 2 });
      f.encoder.sampleCompound.mockResolvedValueOnce({ frame: { ...frame, revision: 2 }, tiles: [{ ...tile, x: 64 }] });
      f.advance(); await f.session.tick();
      expect(f.sent.filter(message => message.kind === 'tiles').at(-1).tiles[0]).not.toHaveProperty('data');
    } finally { await f.session.stop(); }
  });

  it('does not certify queued video and pairs late native metadata with actual RTP delivery', async () => {
    const f = fixture();
    try {
      await f.session.start(); f.advance();
      f.session.handleMessage({ kind: 'ready', version: 1 });
      f.advance();
      f.capture(); await f.session.tick();
      expect(f.sent.some(message => message.kind === 'frame')).toBe(false);
      expect(f.sent.some(message => message.kind === 'tiles')).toBe(false);
      f.session.frameSent({ timestamp: 2 });
      f.capture({ ...frame, timestamp: 2 });
      expect(f.sent.at(-1)).toMatchObject({ kind: 'frame', rtpTimestamp: 180_000 });
    } finally { await f.session.stop(); }
  });

  it('drops samples across resize/revision changes and pause without leaking a late continuation', async () => {
    const f = fixture(); let complete!: (value: any) => void;
    try {
      await f.ready(); f.advance();
      f.encoder.sampleCompound.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      const tick = f.session.tick();
      f.session.pause();
      complete({ frame, tiles: [tile] }); await tick;
      expect(f.sent.some(message => message.kind === 'tiles')).toBe(false);
      f.session.resume(); f.advance();
      f.capture({ ...frame, revision: 2, kind: 'invalidate' });
      await f.session.tick();
      expect(f.sent.some(message => message.kind === 'tiles')).toBe(false);
    } finally { await f.session.stop(); }
  });

  it('resets cache identity on a rejected/expired batch and bounds backpressure', async () => {
    const f = fixture();
    try {
      await f.ready(); f.advance(); await f.session.tick();
      const first = f.sent.find(message => message.kind === 'tiles');
      f.session.handleMessage({ kind: 'ack', epoch: first.epoch, sequence: first.sequence, ok: false });
      f.advance(); await f.session.tick();
      const second = f.sent.filter(message => message.kind === 'tiles').at(-1);
      expect(second.epoch).not.toBe(first.epoch);
      f.advance(2001); await f.session.tick();
      f.transport.canSendCompound.mockReturnValue(false); f.advance();
      const samples = f.encoder.sampleCompound.mock.calls.length;
      await f.session.tick();
      expect(f.encoder.sampleCompound).toHaveBeenCalledTimes(samples);
    } finally { await f.session.stop(); }
  });

  it('restores the full video budget and cleans listeners when the helper or receiver does not support enhancement', async () => {
    const f = fixture();
    f.encoder.enableCompound.mockRejectedValueOnce(new Error('old helper'));
    await f.session.start();
    expect(f.session.active).toBe(false);
    expect(f.session.videoDecision({ bitRate: 8_000_000 }).bitRate).toBe(8_000_000);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    const early = fixture();
    early.session.handleMessage({ kind: 'unsupported' });
    await early.session.start();
    expect(early.encoder.enableCompound).not.toHaveBeenCalled();
  });

  it('partitions the total bitrate and includes presentation barriers in the wire budget', async () => {
    const f = fixture();
    try {
      await f.ready();
      expect(f.session.videoDecision({ bitRate: 8_000_000 }).bitRate).toBe(7_936_000);
      const before = f.sent.length;
      for (let i = 0; i < 10_000; i++) f.session.frameSent({ timestamp: 1 });
      const bytes = f.sent.slice(before).reduce((sum, message) => sum + JSON.stringify(message).length, 0);
      expect(bytes).toBeLessThanOrEqual(4_000);
      f.session.pause();
      expect(f.session.videoDecision({ bitRate: 8_000_000 }).bitRate).toBe(8_000_000);
    } finally { await f.session.stop(); }
  });

  it('discovers demand without spending unearned credit and returns idle bandwidth to H264', async () => {
    const f = fixture();
    try {
      await f.ready();
      const large = { ...tile, bytes: 15_000, data: 'x'.repeat(20_000) };
      f.encoder.sampleCompound.mockResolvedValue({ frame, tiles: [large] });
      f.advance(); await f.session.tick();
      expect(f.encoder.sampleCompound).toHaveBeenCalledWith(48_000, expect.objectContaining({ priorityIndices: expect.any(Array) }));
      expect(f.sent.some(message => message.kind === 'tiles')).toBe(false);
      expect(f.session.credit).toBeLessThanOrEqual(4000);
      expect(f.session.videoDecision({ bitRate: 8_000_000 }).bitRate).toBeLessThan(7_936_000);
      f.advance(); await f.session.tick();
      const batch = f.sent.find(message => message.kind === 'tiles');
      expect(batch).toBeDefined();
      f.session.handleMessage({ kind: 'ack', epoch: batch.epoch, sequence: batch.sequence, ok: true });
      f.encoder.sampleCompound.mockResolvedValue({ frame, tiles: [] });
      f.advance(2500); await f.session.tick();
      expect(f.session.videoDecision({ bitRate: 8_000_000 }).bitRate).toBe(7_936_000);
    } finally { await f.session.stop(); }
  });

  it('negotiates binary only with an explicit format and resets cache identity across a format change', async () => {
    const f = fixture(); const wire: any[] = [];
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.write('IHDR', 12); png.writeUInt32BE(64, 16); png.writeUInt32BE(64, 20);
    Object.assign(f.transport, {
      compoundEncodingCost: compoundTileEncodingCost,
      prepareCompound: (message: any, format: string) => {
        const data = format === 'binary-v1' && message.kind === 'tiles' ? encodeCompoundTiles(message) : JSON.stringify(message);
        return { data, bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.length };
      },
    });
    f.transport.sendCompound.mockImplementation(prepared => { wire.push(prepared.data); return true; });
    f.encoder.sampleCompound.mockResolvedValue({ frame, tiles: [{ ...tile, bytes: 24, data: png.toString('base64') }] });
    try {
      f.session.handleMessage({ kind: 'ready', version: 1, formats: ['binary-v1', 'json-v1'] });
      await f.session.start(); f.advance(); f.capture(); f.session.frameSent(frame);
      f.advance(); await f.session.tick();
      const binary = wire.find(data => data instanceof Uint8Array);
      expect(decodeCompoundTiles(binary).tiles[0].cacheId).toBe(1);
      const oldEpoch = decodeCompoundTiles(binary).epoch;
      f.session.handleMessage({ kind: 'ready', version: 1 });
      f.advance(); await f.session.tick();
      const json = wire.filter(data => typeof data === 'string').map(data => JSON.parse(data)).findLast(data => data.kind === 'tiles');
      expect(json.epoch).not.toBe(oldEpoch);
      expect(json.tiles[0]).toHaveProperty('data');
      expect(f.session.active).toBe(true);
    } finally { await f.session.stop(); }
  });

  it('bounds concurrent discovery and can accept a synchronous ACK from an injected transport', async () => {
    const f = fixture(); let resolve!: (value: any) => void;
    try {
      await f.ready(); f.advance();
      f.encoder.sampleCompound.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      const first = f.session.tick(); await f.session.tick();
      expect(f.encoder.sampleCompound).toHaveBeenCalledOnce();
      f.transport.sendCompound.mockImplementation(message => {
        if (message.kind === 'tiles') f.session.handleMessage({ kind: 'ack', epoch: message.epoch, sequence: message.sequence, ok: true });
        return true;
      });
      resolve({ frame, tiles: [tile] }); await first;
      expect(f.session.pending).toBeNull();
      expect(f.session.frames).toBe(1);
    } finally { await f.session.stop(); }
  });

  it('shrinks large invalidations to a full clear when the current control allowance cannot hold them', async () => {
    const f = fixture();
    try {
      f.session.videoDecision({ bitRate: 500_000 });
      await f.ready(); f.advance();
      f.capture({ ...frame, revision: 2, kind: 'invalidate', rects: Array.from({ length: 32 }, () => ({ x: 0, y: 0, width: 64, height: 64 })) });
      const invalidation = f.sent.find(message => message.kind === 'invalidate');
      expect(invalidation).toMatchObject({ revision: 2 });
      expect(invalidation).not.toHaveProperty('rects');
    } finally { await f.session.stop(); }
  });
});
