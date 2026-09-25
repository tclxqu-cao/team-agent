import { spawn } from 'node:child_process';

const CAFFEINATE_PATH = '/usr/bin/caffeinate';

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      resolve(child);
    };
    const onError = (error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** Viewer-scoped macOS display wake and display-sleep inhibition. */
export class MacOSDisplayBridge {
  constructor({
    platform = process.platform,
    parentPid = process.pid,
    spawnProcess = spawn,
  } = {}) {
    this.platform = platform;
    this.parentPid = parentPid;
    this.spawnProcess = spawnProcess;
    this.hold = null;
    this.startPromise = null;
  }

  get supported() { return this.platform === 'darwin'; }

  async wake() {
    if (!this.supported) throw new Error('显示器唤醒仅支持 macOS');
    const child = this.spawnProcess(CAFFEINATE_PATH, ['-u', '-t', '3'], { stdio: 'ignore' });
    child.unref?.();
    await waitForSpawn(child);
    return { ok: true, woke: true };
  }

  start() {
    if (!this.startPromise) {
      this.startPromise = this.startHolding().finally(() => { this.startPromise = null; });
    }
    return this.startPromise;
  }

  async startHolding() {
    if (this.hold) return { ok: true, held: true };
    await this.wake();
    const child = this.spawnProcess(CAFFEINATE_PATH, ['-d', '-w', String(this.parentPid)], { stdio: 'ignore' });
    this.hold = child;
    const clear = () => { if (this.hold === child) this.hold = null; };
    child.once('exit', clear);
    child.once('error', clear);
    child.unref?.();
    try {
      await waitForSpawn(child);
      return { ok: true, held: true };
    } catch (error) {
      clear();
      throw error;
    }
  }

  async stop() {
    const child = this.hold;
    this.hold = null;
    if (child && !child.killed) child.kill('SIGTERM');
    return { ok: true, held: false };
  }
}
