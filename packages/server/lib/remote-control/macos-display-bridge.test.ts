import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error gateway ESM
import { MacOSDisplayBridge } from './macos-display-bridge.mjs';

function childProcess() {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; child.emit('exit', 0); return true; });
  child.unref = vi.fn();
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

describe('MacOSDisplayBridge', () => {
  it('wakes once per request and holds display sleep only until stop', async () => {
    const children: ReturnType<typeof childProcess>[] = [];
    const spawnProcess = vi.fn(() => {
      const child = childProcess();
      children.push(child);
      return child;
    });
    const bridge = new MacOSDisplayBridge({ platform: 'darwin', parentPid: 4321, spawnProcess });

    await bridge.start();
    expect(spawnProcess).toHaveBeenNthCalledWith(1, '/usr/bin/caffeinate', ['-u', '-t', '3'], { stdio: 'ignore' });
    expect(spawnProcess).toHaveBeenNthCalledWith(2, '/usr/bin/caffeinate', ['-d', '-w', '4321'], { stdio: 'ignore' });

    await bridge.start();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(children[1].kill).not.toHaveBeenCalled();

    await bridge.stop();
    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
    await bridge.stop();
    expect(children[1].kill).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported platforms without spawning a process', async () => {
    const spawnProcess = vi.fn();
    const bridge = new MacOSDisplayBridge({ platform: 'win32', spawnProcess });
    await expect(bridge.wake()).rejects.toThrow('仅支持 macOS');
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
