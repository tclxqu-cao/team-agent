import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error server ESM
import { RemoteHoverDispatch } from './remote-hover-dispatch.mjs';
vi.mock('@agent/core', async original => ({ ...await original<Record<string, unknown>>(), ...await import('../../../../core/src/domain/live-view/index.js') }));
it('flushes the newest position after spacing and cancels pending moves at a reliable barrier', async () => {
  vi.useFakeTimers();
  try {
    const write = vi.fn(), hover = new RemoteHoverDispatch({ clock: { now: Date.now, schedule: setTimeout, cancel: clearTimeout }, write });
    hover.offer({ sequence: 1, x: .1 }); await vi.advanceTimersByTimeAsync(1);
    hover.offer({ sequence: 2, x: .9 }); hover.offer({ sequence: 1, x: .2 });
    expect(write).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(3);
    expect(write).toHaveBeenLastCalledWith({ sequence: 2, x: .9 });
    hover.offer({ sequence: 3 }); hover.cancel(); await vi.advanceTimersByTimeAsync(10);
    expect(write).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
