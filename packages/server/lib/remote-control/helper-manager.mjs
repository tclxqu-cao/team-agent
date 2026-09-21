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
export const MAX_VIDEO_FRAME_BYTES = 8 * 1024 * 1024;
const VIDEO_FRAME_VERSION = 1;
const VIDEO_FRAME_HEADER_BYTES = 12;

export function encodeVideoFrame({ timestamp, nals, key = false }) {
  const payloads = nals.map((nal) => Buffer.from(nal));
  const bodyLength = VIDEO_FRAME_HEADER_BYTES + payloads.reduce((size, nal) => size + 4 + nal.length, 0);
  if (bodyLength > MAX_VIDEO_FRAME_BYTES) throw new Error('native video frame exceeds limit');
  if (payloads.length > 0xffff) throw new Error('native video frame has too many NAL units');
  const frame = Buffer.allocUnsafe(4 + bodyLength);
  frame.writeUInt32BE(bodyLength, 0);
  frame.writeUInt8(VIDEO_FRAME_VERSION, 4);
  frame.writeUInt8(key ? 1 : 0, 5);
  frame.writeUInt16BE(payloads.length, 6);
  frame.writeDoubleBE(timestamp, 8);
  let offset = 16;
  for (const nal of payloads) {
    frame.writeUInt32BE(nal.length, offset); offset += 4;
    nal.copy(frame, offset); offset += nal.length;
  }
  return frame;
}

export function decodeVideoFrames(input) {
  const frames = [];
  let offset = 0;
  while (input.length - offset >= 4) {
    const bodyLength = input.readUInt32BE(offset);
    if (bodyLength < VIDEO_FRAME_HEADER_BYTES || bodyLength > MAX_VIDEO_FRAME_BYTES) throw new Error('invalid native video frame length');
    if (input.length - offset < bodyLength + 4) break;
    const bodyStart = offset + 4;
    const bodyEnd = bodyStart + bodyLength;
    if (input.readUInt8(bodyStart) !== VIDEO_FRAME_VERSION) throw new Error('unsupported native video frame version');
    const flags = input.readUInt8(bodyStart + 1);
    const nalCount = input.readUInt16BE(bodyStart + 2);
    const timestamp = input.readDoubleBE(bodyStart + 4);
    let cursor = bodyStart + VIDEO_FRAME_HEADER_BYTES;
    const nals = [];
    for (let index = 0; index < nalCount; index += 1) {
      if (cursor + 4 > bodyEnd) throw new Error('truncated native video NAL length');
      const nalLength = input.readUInt32BE(cursor); cursor += 4;
      if (nalLength < 1 || cursor + nalLength > bodyEnd) throw new Error('truncated native video NAL payload');
      nals.push(Buffer.from(input.subarray(cursor, cursor + nalLength))); cursor += nalLength;
    }
    if (cursor !== bodyEnd) throw new Error('native video frame has trailing bytes');
    if (!Number.isFinite(timestamp)) throw new Error('native video frame has invalid timestamp');
    frames.push({ timestamp, nals, key: Boolean(flags & 1) });
    offset = bodyEnd;
  }
  return { frames, remaining: Buffer.from(input.subarray(offset)) };
}

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
  constructor({ appPath = defaultAppPath(), launch = (socket, videoSocket) => run('/usr/bin/open', ['-n', appPath, '--args', socket, videoSocket, String(process.pid)]), stopTimeoutMs = 1000 } = {}) {
    this.appPath = appPath; this.launch = launch; this.stopTimeoutMs = stopTimeoutMs; this.pending = new Map(); this.videoListeners = new Set(); this.sequence = 0; this.generation = 0;
  }
  onVideo(listener) { this.videoListeners.add(listener); return () => this.videoListeners.delete(listener); }
  async available() { try { await access(join(this.appPath, 'Contents/MacOS/agentroam-remote-desktop')); return true; } catch { return false; } }
  start() {
    if (this.socket && !this.socket.destroyed && this.videoSocket && !this.videoSocket.destroyed) return Promise.resolve();
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
      const videoSocketPath = join(this.directory, 'video.sock');
      this.videoServer = createServer();
      await new Promise((resolve, reject) => { this.videoServer.once('error', reject); this.videoServer.listen(videoSocketPath, resolve); });
      let cancelControl = () => {};
      let cancelVideo = () => {};
      this.cancelStart = () => { cancelControl(); cancelVideo(); };
      const controlReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('远程授权组件启动超时')), 15000);
        cancelControl = () => { clearTimeout(timer); reject(new Error('远程授权组件启动已取消')); };
        this.server.once('connection', (socket) => {
          clearTimeout(timer); cancelControl = () => {};
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
      });
      const videoReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('远程视频通道启动超时')), 15000);
        cancelVideo = () => { clearTimeout(timer); reject(new Error('远程授权组件启动已取消')); };
        this.videoServer.once('connection', (socket) => {
          clearTimeout(timer); cancelVideo = () => {};
          if (generation !== this.generation) { socket.destroy(); reject(new Error('远程授权组件启动已取消')); return; }
          this.videoSocket = socket;
          this.videoServer.on('connection', (extra) => extra.destroy());
          let buffer = Buffer.alloc(0);
          socket.on('data', (chunk) => {
            try {
              buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
              const decoded = decodeVideoFrames(buffer); buffer = decoded.remaining;
              for (const frame of decoded.frames) for (const listener of this.videoListeners) listener(frame);
            } catch {
              socket.destroy();
            }
          });
          socket.on('error', () => undefined);
          socket.on('close', () => {
            if (this.videoSocket !== socket) return;
            this.videoSocket = null;
            for (const listener of this.videoListeners) listener({ error: '远程视频通道已断开' });
          });
          resolve();
        });
      });
      await Promise.all([controlReady, videoReady, this.launch(socketPath, videoSocketPath)]);
      this.cancelStart = null;
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
    const socket = this.socket;
    if (socket && !socket.destroyed) {
      const closed = new Promise((resolve) => socket.once('close', resolve));
      try { socket.write(JSON.stringify({ op: 'quit', id: ++this.sequence }) + '\n'); } catch {}
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, this.stopTimeoutMs))]);
    }
    socket?.destroy(); this.socket = null; this.videoSocket?.destroy(); this.videoSocket = null; this.rejectPending();
    if (this.server) { this.server.close(); this.server = null; }
    if (this.videoServer) { this.videoServer.close(); this.videoServer = null; }
    if (this.directory) { await rm(this.directory, { recursive: true, force: true }); this.directory = null; }
  }
}
