import { describe, expect, it, vi } from 'vitest';
import { LiveViewRegistry } from '../../../core/src/domain/live-view/live-view-registry';
import { ViewerFrameFlow } from './viewer-frame-flow.mjs';
import { relayViewerVideoSignal } from './viewer-video-flow.mjs';

function fixture() {
  const registry = new LiveViewRegistry();
  const peer = (id: string) => ({ id, userId: 'owner', producerSessionIds: new Set<string>(), watchedSessionId: null, send: vi.fn() });
  const producer = peer('producer'), controller = peer('controller'), observer = peer('observer');
  for (const p of [producer, controller, observer]) registry.connect(p);
  registry.publish(producer, { sessionId: 'desktop', backend: 'desktop', availability: 'ready' });
  registry.watch(controller, 'desktop');
  registry.watch(observer, 'desktop');
  registry.takeOver(controller, 'desktop');
  registry.producerState(producer, 'desktop', 'user-controlled');
  const send = vi.fn(), observerSend = vi.fn();
  return { registry, producer, controller, observer, send, observerSend,
    flow: new ViewerFrameFlow(send), observerFlow: new ViewerFrameFlow(observerSend) };
}

describe('viewer video delivery', () => {
  it('pauses only the playing controller and immediately resumes its latest fallback', () => {
    const f = fixture();
    relayViewerVideoSignal(f.registry, f.controller, 'desktop', { kind: 'viewer-trace', event: 'playback-ready' }, f.flow);
    for (let sequence = 1; sequence <= 20; sequence++) {
      const frame = { channelId: 1, sequence, bytes: new Uint8Array(32) };
      f.flow.offer(frame); f.observerFlow.offer(frame);
    }
    expect(f.send).not.toHaveBeenCalled();
    expect(f.observerSend).toHaveBeenCalledTimes(20);
    relayViewerVideoSignal(f.registry, f.controller, 'desktop', { kind: 'viewer-trace', event: 'jpeg-fallback' }, f.flow);
    expect(f.send.mock.calls.map(([frame]) => frame.sequence)).toEqual([20]);
  });

  it('does not change delivery for unauthorized or malformed signals', () => {
    const f = fixture();
    expect(() => relayViewerVideoSignal(f.registry, f.observer, 'desktop', { kind: 'viewer-trace', event: 'playback-ready' }, f.observerFlow))
      .toThrow('browser is read-only');
    expect(f.observerFlow.paused).toBe(false);
    expect(() => relayViewerVideoSignal(f.registry, f.controller, 'desktop', { kind: 'viewer-trace', event: 42 }, f.flow)).toThrow();
    expect(f.flow.paused).toBe(false);
  });

  it.each(['start', 'stop'])('restores JPEG delivery when video receives %s', (kind) => {
    const f = fixture();
    f.flow.setPaused(true);
    relayViewerVideoSignal(f.registry, f.controller, 'desktop', { kind }, f.flow);
    expect(f.flow.paused).toBe(false);
  });
});
