import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_MESSAGE = 8 * 1024 * 1024;
function defaultExecutable() {
  const bundled = fileURLToPath(new URL('../../native/agentroam-remote-desktop.exe', import.meta.url));
  const development = fileURLToPath(new URL('../../native/.build-remote/windows/agentroam-remote-desktop.exe', import.meta.url));
  return existsSync(bundled) || !existsSync(development) ? bundled : development;
}
// Inherited pipes are private to this process tree; there is no named pipe or TCP listener.
export class WindowsRemoteHelper {
  constructor({ executable = defaultExecutable(), launch = spawn } = {}) {
    this.executable = executable; this.launch = launch; this.sequence = 0;
    this.pending = new Map(); this.listeners = new Set(); this.generation = 0;
  }
  async available() { try { await access(this.executable); return true; } catch { return false; } }
  onVideo(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  start() {
    if (this.starting) return this.starting;
    if (this.child && this.child.exitCode === null && !this.child.killed) return Promise.resolve();
    const generation = this.generation;
    this.starting = this.open(generation).finally(() => { this.starting = null; });
    return this.starting;
  }
  async open(generation) {
    if (!await this.available()) throw new Error('当前 CLI 未包含 Windows 远程桌面组件，请升级 CLI');
    if (generation !== this.generation) throw new Error('远程桌面组件启动已取消');
    const child = this.launch(this.executable, ['--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let buffer = '';
    const fail = (error) => {
      if (this.child !== child) return;
      this.child = null; this.rejectPending(error); child.kill();
      for (const listener of this.listeners) listener({ error: error.message });
    };
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error((code >>> 0) === 0xc0000135 ? 'Windows 远程桌面组件缺少系统依赖，请安装 Windows 媒体功能包' : 'Windows 远程桌面组件已退出')));
    child.stdin.on('error', fail);
    // Drain diagnostics without exposing potentially sensitive desktop content in logs.
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (end > MAX_MESSAGE) { fail(new Error('远程桌面组件响应过大')); return; }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const result = JSON.parse(line);
          if (result.event === 'video') {
            if (!Number.isFinite(result.timestamp) || !Array.isArray(result.nals) || !result.nals.every(nal => typeof nal === 'string')) throw new Error('Invalid video event');
            for (const listener of this.listeners) listener(result);
          } else if (result.event === 'video-error') {
            for (const listener of this.listeners) listener({ error: String(result.error || 'Windows 视频编码失败') });
          } else {
            const pending = this.pending.get(result.id);
            if (pending) {
              clearTimeout(pending.timer); this.pending.delete(result.id);
              result.ok === true ? pending.resolve(result) : pending.reject(new Error(String(result.error || 'Windows 远程桌面操作失败')));
            }
          }
        } catch { fail(new Error('Windows 远程桌面协议响应无效')); return; }
      }
      if (buffer.length > MAX_MESSAGE) fail(new Error('远程桌面组件响应过大'));
    });
    try {
      await this.request({ op: 'status' });
      if (generation !== this.generation) throw new Error('远程桌面组件启动已取消');
    } catch (error) { if (this.child === child) { this.child = null; child.kill(); this.rejectPending(error); } throw error; }
  }
  request(command) {
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) return Promise.reject(new Error('Windows 远程桌面组件未连接'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Windows 远程桌面请求过多'));
    const id = ++this.sequence;
    const line = JSON.stringify({ ...command, id }) + '\n';
    if (Buffer.byteLength(line) > 65536) return Promise.reject(new Error('远程桌面请求过大'));
    if (child.stdin.writableLength > 1024 * 1024) return Promise.reject(new Error('远程桌面组件繁忙'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Windows 远程桌面组件响应超时')); }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(line, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  rejectPending(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  async stop() {
    this.generation++;
    const child = this.child;
    this.child = null;
    this.rejectPending(new Error('远程桌面组件启动已取消或已停止'));
    if (!child) return;
    // EOF triggers native release of every held key/button before process exit.
    await new Promise(resolve => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
