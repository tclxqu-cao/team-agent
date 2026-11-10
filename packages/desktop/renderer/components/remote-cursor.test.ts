import { expect, it, vi } from 'vitest';
import { BrowserRemoteCursor } from './remote-cursor.js';

function fixture() {
  const ctx = Object.fromEntries(['clearRect', 'save', 'restore', 'translate', 'scale', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'drawImage'].map(name => [name, vi.fn()]));
  const canvas = { width: 128, height: 64, style: { visibility: 'hidden' }, getContext: () => ctx };
  let frame!: (now: number, metadata: any) => void;
  const video = { videoWidth: 128, videoHeight: 64, srcObject: {}, requestVideoFrameCallback: vi.fn(fn => { frame = fn; return 1; }), cancelVideoFrameCallback: vi.fn() };
  const listeners = new Map(); const peer = { addEventListener: (kind: string, fn: any) => listeners.set(kind, fn), removeEventListener: vi.fn() };
  const channel: any = { label: 'agentroam.cursor.v1', close: vi.fn() };
  const cursor = new BrowserRemoteCursor({ getVideo: () => video as any, getCanvas: () => canvas as any }); cursor.attach(peer as any);
  listeners.get('datachannel')({ channel });
  const send = (props = {}) => cursor.receive(JSON.stringify({ sequence: 1, x: 0.5, y: 0.5, visible: true, active: true, cutoverRtp: 90_000, ...props }));
  return { cursor, canvas, ctx, video, channel, send, frame: (rtp: number) => frame(0, { rtpTimestamp: rtp }) };
}
it('gates a separate cursor on video cutover and provides immediate local pointer feedback', () => {
  const f = fixture(); try {
    f.send(); f.frame(80_000); expect(f.canvas.style.visibility).toBe('hidden');
    f.frame(90_000); expect(f.canvas.style.visibility).toBe('visible');
    expect(f.ctx.translate).toHaveBeenLastCalledWith(64, 32);
    f.cursor.localPoint({ x: 0.75, y: 0.25 }); expect(f.ctx.translate).toHaveBeenLastCalledWith(96, 16);
    f.send({ sequence: 0, x: 0 }); expect(f.ctx.translate).toHaveBeenLastCalledWith(96, 16);
    f.channel.onclose(); f.frame(100_000); expect(f.canvas.style.visibility).toBe('hidden');
    expect(f.video.srcObject).toEqual({});
  } finally { f.cursor.stop(); }
  expect(f.video.cancelVideoFrameCallback).toHaveBeenCalled();
});
it('ignores malformed position metadata and cleans the independent channel', () => {
  const f = fixture(); try { f.send({ x: Infinity }); f.frame(90_000); expect(f.canvas.style.visibility).toBe('hidden'); } finally { f.cursor.stop(); }
  expect(f.channel.close).toHaveBeenCalled();
});
