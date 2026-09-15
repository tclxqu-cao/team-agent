import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { mkdtemp, chmod, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
// A high-resolution H264 keyframe can exceed the old 2 MB JSON limit.
export const MAX_HELPER_MESSAGE_CHARS = 8 * 1024 * 1024;

function defaultAppPath() {
  const installed = join(homedir(), 'Library/Application Support/AgentRoamRemoteDesktop/Services.noindex/AgentRoam Remote Desktop.app');
  const bundled = fileURLToPath(new URL('../../native/AgentRoam Remote Desktop.app', import.meta.url));
  const executable = 'Contents/MacOS/agentroam-remote-desktop';
  try {
    if (readFileSync(join(installed, executable)).equals(readFileSync(join(bundled, executable)))) return installed;
  } catch { /* Use this runtime's bundled version when not installed or outdated. */ }
  return bundled;
}

export class RemoteHelper {
  constructor({ appPath = defaultAppPath(), launch = (socket) => run('/usr/bin/open', ['-n', appPath, '--args', socket, String(process.pid)]) } = {}) {
    this.appPath = appPath; this.launch = launch; this.pending = new Map(); this.videoListeners = new Set(); this.sequence = 0; this.generation = 0;
  }
  onVideo(listener) { this.videoListeners.add(listener); return () => this.videoListeners.delete(listener); }
  async available() { try { await access(join(this.appPath, 'Contents/MacOS/agentroam-remote-desktop')); return true; } catch { return false; } }
  start() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (!this.starting) this.starting = this.open().finally(() => { this.starting = null; });
    return this.starting;
  }
  async open() {
    await this.stop();
    const generation = this.generation;
    if (!await this.available()) throw new Error('当前 CLI 未包含远程授权组件，请升级 CLI');
    this.directory = await mkdtemp('/tmp/agentroam-remote-');
    await chmod(this.directory, 0o700);
    if (generation !== this.generation) { await this.stop(); throw new Error('远程授权组件启动已取消'); }
    const socketPath = join(this.directory, 'bridge.sock');
    this.server = createServer();
    try {
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(socketPath, resolve); });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('远程授权组件启动超时')), 15000);
        this.cancelStart = () => { clearTimeout(timer); reject(new Error('远程授权组件启动已取消')); };
        this.server.once('connection', (socket) => {
          clearTimeout(timer); this.cancelStart = null;
          if (generation !== this.generation) { socket.destroy(); reject(new Error('远程授权组件启动已取消')); return; }
          this.socket = socket;
          // Only one local helper may use this private socket.
          this.server.on('connection', (extra) => extra.destroy());
          let buffer = '';
          socket.setEncoding('utf8');
          socket.on('data', (chunk) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
              if (newline > MAX_HELPER_MESSAGE_CHARS) { socket.destroy(); return; }
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              try {
                const result = JSON.parse(line);
                if (result.event === 'video') { for (const listener of this.videoListeners) listener(result); continue; }
                const pending = this.pending.get(result.id);
                if (pending) { clearTimeout(pending.timer); this.pending.delete(result.id); result.ok ? pending.resolve(result) : pending.reject(new Error(result.error || '本机组件请求失败')); }
              } catch { socket.destroy(); return; }
            }
            if (buffer.length > MAX_HELPER_MESSAGE_CHARS) socket.destroy();
          });
          socket.on('error', () => undefined);
          socket.on('close', () => { if (this.socket === socket) this.socket = null; this.rejectPending(); });
          resolve();
        });
        void this.launch(socketPath).catch((error) => { clearTimeout(timer); reject(error); });
      });
    } catch (error) { await this.stop(); throw error; }
  }
  request(command) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('远程授权组件未连接'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('远程授权组件响应超时')); }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }
  rejectPending() { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('远程授权组件已断开')); } this.pending.clear(); }
  async stop() {
    this.generation += 1; this.cancelStart?.(); this.cancelStart = null;
    this.socket?.destroy(); this.socket = null; this.rejectPending();
    if (this.server) { this.server.close(); this.server = null; }
    if (this.directory) { await rm(this.directory, { recursive: true, force: true }); this.directory = null; }
  }
}
