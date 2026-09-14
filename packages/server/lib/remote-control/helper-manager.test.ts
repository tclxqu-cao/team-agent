import { it, expect, vi } from 'vitest';
import { RemoteHelper } from './helper-manager.mjs';
it('cancels a pending native launch immediately and permits retry', async () => {
  const launch = vi.fn(async()=>{});
  const helper = new RemoteHelper({launch});
  helper.available = async()=>true;
  const start = helper.start();
  const cancelled = expect(start).rejects.toThrow('取消');
  await vi.waitFor(()=>expect(launch).toHaveBeenCalledOnce());
  await helper.stop(); await cancelled;
  expect(helper.starting).toBeNull(); expect(helper.directory).toBeNull();
});
