import { describe, expect, it, vi } from 'vitest';
import { BrowserRemoteDirectInput } from './remote-direct-input.js';

function fixture() {
  const listeners = new Map<string, Function>();
  const peer = { addEventListener: (key: string, fn: Function) => listeners.set(key, fn), removeEventListener: (key: string) => listeners.delete(key) };
  const channel = { label: 'agentroam.input.v1', readyState: 'open', bufferedAmount: 0, send: vi.fn(), close: vi.fn(), onclose: undefined as (() => void) | undefined };
  const client = new BrowserRemoteDirectInput('input-stream-1234567890');
  client.attach(peer as any); listeners.get('datachannel')!({ channel });
  return { client, channel, listeners };
}

describe('browser direct hover input', () => {
  it('uses the channel for hover and fences reliable drag, clicks and keys', () => {
    const f = fixture(), point = { kind: 'pointer', action: 'move', x: .2, y: .3 };
    expect(f.client.prepare(point).fast).toBe(true);
    expect(JSON.parse(f.channel.send.mock.calls[0][0])).toMatchObject({ sequence: 1, barrier: 0, x: .2 });
    expect(f.client.prepare({ ...point, action: 'down' })).toMatchObject({ fast: false, input: { direct: { sequence: 2 } } });
    expect(f.client.prepare(point).fast).toBe(false);
    expect(f.client.prepare({ ...point, action: 'up' })).toMatchObject({ fast: false, input: { direct: { sequence: 4 } } });
    expect(f.client.prepare(point).fast).toBe(true);
    expect(JSON.parse(f.channel.send.mock.calls[1][0])).toMatchObject({ sequence: 5, barrier: 4 });
    expect(f.client.prepare({ kind: 'key', key: 'x' }).fast).toBe(false);
    expect(f.client.prepare({ ...point, probe: true }).fast).toBe(false);
    expect(f.client.prepare({ ...point, action: 'wheel' }).fast).toBe(false);
  });
  it('falls back on backpressure, close, write failure and unsupported peers', () => {
    const f = fixture(), point = { kind: 'pointer', action: 'move', x: .2, y: .3 };
    f.channel.bufferedAmount = 16_000;
    expect(f.client.prepare(point)).toMatchObject({ fast: false, input: { direct: { sequence: 1 } } });
    f.channel.bufferedAmount = 0; f.channel.send.mockImplementationOnce(() => { throw new Error('closed'); });
    expect(f.client.prepare(point).fast).toBe(false);
    f.channel.onclose?.(); expect(f.client.prepare(point).fast).toBe(false);
    f.client.stop(); expect(f.listeners.size).toBe(0);
    expect(f.client.prepare(point).input).toEqual(point);
    expect(new BrowserRemoteDirectInput().prepare(point)).toEqual({ fast: false, input: point });
  });
  it('suspends the fast path in the background while retaining the stream and reliable fence', () => {
    const f = fixture(), point = { kind: 'pointer', action: 'move', x: .2, y: .3 };
    f.client.setVisible(false);
    expect(f.client.prepare(point)).toMatchObject({ fast: false, input: { direct: { sequence: 1 } } });
    expect(f.channel.send).not.toHaveBeenCalled();
    f.client.setVisible(true);
    expect(f.client.prepare(point).fast).toBe(true);
    expect(JSON.parse(f.channel.send.mock.calls[0][0])).toMatchObject({ sequence: 2, barrier: 1 });
    expect(f.channel.close).not.toHaveBeenCalled(); f.client.stop();
  });
});

function reliableFixture() {
  const listeners = new Map<string, Function>();
  const peer = { addEventListener: (key: string, fn: Function) => listeners.set(key, fn), removeEventListener: (key: string) => listeners.delete(key) };
  const reliable = { label: 'agentroam.input.reliable.v1', readyState: 'open', bufferedAmount: 0, send: vi.fn(), close: vi.fn(), onclose: undefined as any, onmessage: undefined as any };
  const hover = { ...reliable, label: 'agentroam.input.v1', send: vi.fn() };
  const onError = vi.fn(), client = new BrowserRemoteDirectInput('input-stream-1234567890', 2, onError);
  client.attach(peer as any); listeners.get('datachannel')!({ channel: reliable }); listeners.get('datachannel')!({ channel: hover });
  const ack = (index: number, result: any) => { const request = reliable.send.mock.calls.map(([raw]) => JSON.parse(raw)).find(message => message.index === index);
    reliable.onmessage({ data: JSON.stringify({ ...request, kind: 'result', ok: true, result }) }); };
  return { client, reliable, hover, ack, onError };
}

describe('reliable direct actions', () => {
  it('waits for native replies and keeps hit-test payloads in the RPC shape', async () => {
    const f = reliableFixture(), fallback = vi.fn();
    const operation = f.client.dispatch({ kind: 'pointer', action: 'up', x: .2, y: .3 }, fallback);
    expect(JSON.parse(f.reliable.send.mock.calls[0][0])).toMatchObject({ index: 1, sequence: 1, input: { direct: { index: 1 } } });
    f.ack(1, { editable: true }); expect(await operation).toEqual({ input: { editable: true } });
    expect(fallback).not.toHaveBeenCalled(); f.client.stop();
  });
  it('reconciles a lost receipt with the same text id and ignores late duplicates', async () => {
    vi.useFakeTimers(); const f = reliableFixture(), fallback = vi.fn(async () => ({ input: { inserted: true } }));
    try {
      const operation = f.client.dispatch({ kind: 'key', text: '中文文本' }, fallback);
      await vi.advanceTimersByTimeAsync(750); expect(await operation).toEqual({ input: { inserted: true } });
      expect(fallback).toHaveBeenCalledWith(JSON.parse(f.reliable.send.mock.calls[0][0]).input);
      f.ack(1, { inserted: true }); expect(fallback).toHaveBeenCalledTimes(1);
    } finally { f.client.stop(); vi.useRealTimers(); }
  });
  it('compensates the final lossy hover after 40ms and cancels it on barriers and hide', async () => {
    vi.useFakeTimers(); const f = reliableFixture(), fallback = vi.fn();
    const point = { kind: 'pointer', action: 'move', x: .9, y: .4 };
    try {
      await f.client.dispatch(point, fallback); await vi.advanceTimersByTimeAsync(39); expect(f.reliable.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(JSON.parse(f.reliable.send.mock.calls[0][0])).toMatchObject({ index: 1, input: point }); f.ack(1, null);
      await f.client.dispatch(point, fallback); const down = f.client.dispatch({ ...point, action: 'down' }, fallback); f.ack(2, null); await down;
      await vi.advanceTimersByTimeAsync(50); expect(f.reliable.send).toHaveBeenCalledTimes(2);
      const up = f.client.dispatch({ ...point, action: 'up' }, fallback); f.ack(3, null); await up;
      await f.client.dispatch(point, fallback); f.client.setVisible(false); await vi.advanceTimersByTimeAsync(50);
      expect(f.reliable.send).toHaveBeenCalledTimes(3);
    } finally { f.client.stop(); vi.useRealTimers(); }
  });
  it('limits flight and queue without allocating gaps and cancels old operations at stop', async () => {
    const f = reliableFixture(), fallback = vi.fn();
    const operations = Array.from({ length: 80 }, () => f.client.dispatch({ kind: 'key', key: 'a' }, fallback));
    const observed = Promise.allSettled(operations);
    expect(f.reliable.send).toHaveBeenCalledTimes(16);
    await expect(f.client.dispatch({ kind: 'key', key: 'b' }, fallback)).rejects.toMatchObject({ code: 'EBUSY' });
    f.ack(1, null); expect(f.reliable.send).toHaveBeenCalledTimes(17);
    f.client.stop(); const results = await observed;
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
  });
  it('uses the request port on close and backpressure, and exposes explicit dispatch failure', async () => {
    const f = reliableFixture(), fallback = vi.fn(async () => ({ input: null }));
    const first = f.client.dispatch({ kind: 'key', key: 'a' }, fallback); f.reliable.onclose(); await first;
    expect(fallback).toHaveBeenCalledTimes(1); f.client.stop();
    const second = reliableFixture(); second.reliable.bufferedAmount = 64_000;
    await second.client.dispatch({ kind: 'key', key: 'b' }, fallback); expect(fallback).toHaveBeenCalledTimes(2); second.client.stop();
    const third = reliableFixture(); const failed = third.client.dispatch({ kind: 'key', key: 'c' }, fallback);
    const request = JSON.parse(third.reliable.send.mock.calls[0][0]);
    third.reliable.onmessage({ data: JSON.stringify({ ...request, kind: 'result', ok: false, error: '控制已归还', code: 'ESTALE' }) });
    await expect(failed).rejects.toMatchObject({ message: '控制已归还', code: 'ESTALE' }); expect(fallback).toHaveBeenCalledTimes(2);
  });
});
