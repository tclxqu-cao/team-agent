import { WindowsRemoteHelper } from './windows-helper.mjs';
import { RemoteWebrtcVideo } from './webrtc-video.mjs';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { RemoteHelper } from './helper-manager.mjs';

export function isLocalAuthorizationRequest(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  if (Object.keys(req.headers).some((key) => /^(forwarded|x-forwarded-|cf-|x-real-ip)/i.test(key))) return false;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${req.headers.host}`).hostname); } catch { return false; }
}

export function supportsRemoteDesktop(platform = process.platform, arch = process.arch, release = os.release()) {
  const major = Number(release.split('.')[0]);
  return (platform === 'darwin' && arch === 'arm64' && major >= 23)
    || (platform === 'win32' && arch === 'x64' && major >= 10);
}

export class RemoteAuthorization {
  constructor({ registry, userId, dataDir, platform = process.platform, helper = platform === 'win32' ? new WindowsRemoteHelper() : new RemoteHelper(), supported = supportsRemoteDesktop(platform), intervalMs = 150 }) {
    Object.assign(this, { registry, dataDir, helper, supported, intervalMs, platform });
    this.enabled = false; this.screen = false; this.accessibility = false; this.online = false; this.error = null; this.busy = false; this.sequence = 0; this.generation = 0;
    this.sessionId = 'cli-desktop:primary';
    this.peer = { id: `cli-remote:${randomUUID()}`, userId, producerSessionIds: new Set(), watchedSessionId: null, send: (event) => {
      const generation = this.switching ? -1 : this.generation;
      this.inputQueue = this.inputQueue.then(() => this.onEvent(event, generation)).catch((error) => { this.error = error.message; });
    } };
    this.inputQueue = Promise.resolve();
    this.video = new RemoteWebrtcVideo({ helper, signal: data => { if (this.enabled && this.online) this.registry.webrtcFromProducer(this.peer, this.sessionId, data); } });
    this.stateFile = join(dataDir, 'remote-authorization.json');
  }
  async initialize() {
    if (!this.supported) return;
    try { this.enabled = JSON.parse(await readFile(this.stateFile, 'utf8')).enabled === true; } catch {}
    this.registry.connect(this.peer);
    this.timer = setInterval(() => { if (this.enabled) void this.tick(); }, this.intervalMs); this.timer.unref();
  }
  async status(local = true) {
    return { local, platform: this.platform, supported: this.supported, installed: this.supported && await this.helper.available(), enabled: this.enabled, screen: this.screen, accessibility: this.accessibility, online: this.online, error: this.error };
  }
  async save() { await mkdir(this.dataDir, { recursive: true }); await writeFile(this.stateFile, JSON.stringify({ enabled: this.enabled }), { mode: 0o600 }); }
  async action(action, permission) {
    if (!this.supported) throw new Error('远程桌面支持 Windows 10/11 x64 和 macOS 14 及以上的 Apple Silicon 电脑');
    if (!['authorize', 'enable', 'disable', 'recheck', 'restart'].includes(action)) throw new Error('未知远程授权操作');
    if (action === 'authorize' && this.platform === 'win32') throw new Error('Windows 请直接点击开启共享');
    if (action === 'authorize' && !['screen', 'accessibility'].includes(permission)) throw new Error('未知权限');
    if (action === 'recheck') {
      await this.helper.start();
      const permissions = await this.helper.request({ op: 'status' });
      this.screen = permissions.screen === true; this.accessibility = permissions.accessibility === true;
      this.lastPermissionCheck = Date.now();
      if (!this.enabled) await this.helper.stop();
      return this.status();
    }
    this.generation += 1;
    this.lastPermissionCheck = 0;
    if (action === 'disable') {
      this.enabled = false; await this.video.stop(); await this.save();
      if (this.online) this.registry.close(this.peer, this.sessionId);
      this.online = false; await this.helper.stop();
    } else {
      this.enabled = true; this.retryAt = 0; await this.save();
      if (action === 'restart') { await this.video.stop(); await this.helper.stop(); }
      await this.helper.start();
      if (action === 'authorize') await this.helper.request({ op: 'authorize', permission });
      await this.tick();
    }
    return this.status();
  }
  tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.captureTick().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }
  async captureTick() {
    if (this.switching || this.busy || !this.enabled || Date.now() < (this.retryAt || 0)) return;
    this.busy = true;
    const generation = this.generation;
    try {
      await this.helper.start();
      if (!this.enabled || generation !== this.generation) return;
      // Permissions need not be polled at the frame rate.
      if (!this.lastPermissionCheck || Date.now() - this.lastPermissionCheck > 2000) {
        const permissions = await this.helper.request({ op: 'status' });
        this.screen = permissions.screen === true; this.accessibility = permissions.accessibility === true; this.lastPermissionCheck = Date.now();
        if (!this.screen) this.error = permissions.error || (this.platform === 'win32' ? '请在 Windows 上恢复已登录的普通桌面' : '请先授予屏幕录制权限');
      }
      if (!this.screen) { this.bounds = null; await this.releaseInput(); await this.video.stop(); if (this.online) this.registry.close(this.peer, this.sessionId); this.online = false; return; }
      if (this.video.connected && Date.now() - (this.lastPreview || 0) < 2000) return;
      const frame = await this.helper.request({ op: 'capture' });
      this.lastPreview = Date.now();
      if (!this.enabled || generation !== this.generation) return;
      this.publishFrame(frame);
      this.error = null;
    } catch (error) {
      if (generation !== this.generation) return;
      this.bounds = null; await this.releaseInput();
      this.error = error.message; this.retryAt = Date.now() + 3000;
      if (this.online) this.registry.close(this.peer, this.sessionId);
      this.online = false;
    } finally { this.busy = false; }
  }
  publishFrame(frame) {
    this.viewport = { width: frame.width, height: frame.height, deviceScaleFactor: 1 }; this.bounds = frame;
    const previousQuality = this.quality;
    this.quality = frame.quality ?? this.quality ?? 'hd';
    const displays = frame.displays ?? this.displays ?? null;
    if (!this.online || JSON.stringify(displays) !== JSON.stringify(this.displays)) {
      this.displays = displays;
      this.registry.publish(this.peer, { sessionId: this.sessionId, backend: 'desktop', title: '本机桌面', url: '', viewport: this.viewport, displays, transport: 'cdp-jpeg-ws' });
      this.online = true;
    }
    this.registry.updateFrame(this.peer, { sessionId: this.sessionId, sequence: ++this.sequence, data: Buffer.from(frame.data, 'base64'), mime: 'image/jpeg', viewport: this.viewport, title: '本机桌面', timestamp: Date.now() });
    if (previousQuality !== this.quality) this.registry.webrtcFromProducer(this.peer, this.sessionId, {kind:'quality-state',quality:this.quality});
  }
  async setDisplay(displayId) {
    if (!this.displays?.some(display => display.id === displayId)) throw new Error('屏幕已断开，请刷新屏幕列表');
    return this.reconfigureCapture({ op: 'set-display', displayId });
  }
  async setQuality(quality) {
    if (!['smooth', 'hd', 'original'].includes(quality)) throw new Error('未知画质档位');
    return this.reconfigureCapture({ op: 'set-quality', quality });
  }
  async reconfigureCapture(command) {
    this.switching = true;
    const generation = ++this.generation;
    this.video.pause();
    try {
      await this.tickPromise;
      if (!this.enabled || generation !== this.generation) return;
      if (this.pointerDown) {
        await this.helper.request({ op: 'up', ...this.lastPointer, button: this.pointerButton || 'left' });
        this.pointerDown = false;
      }
      this.bounds = null;
      const frame = await this.helper.request(command);
      if (!this.enabled || generation !== this.generation) return;
      this.publishFrame(frame);
      this.lastPreview = Date.now(); this.error = null;
    } finally {
      this.switching = false;
      if (this.enabled && generation === this.generation) await this.video.resume();
    }
  }
  async onEvent(event, generation = this.generation) {
    if (!this.enabled || event.sessionId !== this.sessionId) return;
    if (event.type === 'browser:set-display') { await this.setDisplay(event.displayId); return; }
    if (event.type === 'browser:webrtc') {
      const signalQuality = (error) => this.registry.webrtcFromProducer(this.peer, this.sessionId, { kind: 'quality-state', quality: this.quality || 'hd', ...(error ? { error } : {}) });
      if (event.data.kind === 'quality') {
        try { await this.setQuality(event.data.quality); if (this.enabled && this.online) signalQuality(); }
        catch (error) { this.error = error.message; if (this.enabled && this.online) signalQuality(error.message); }
        return;
      }
      if (event.data.kind === 'start') signalQuality();
      await this.video.handle(event.data); return;
    }
    if (event.type === 'browser:takeover-requested') this.registry.producerState(this.peer, this.sessionId, 'user-controlled');
    else if (event.type === 'browser:return-requested') { await this.releaseInput(); await this.video.stop(); this.registry.producerState(this.peer, this.sessionId, 'agent-controlled'); }
    else if (event.type === 'browser:input') {
      try {
        if (generation !== this.generation || !this.bounds) throw new Error('屏幕正在切换，请等待新画面');
        if (!this.accessibility) throw new Error(this.platform === 'win32' ? 'Windows 桌面输入暂不可用，请恢复普通桌面' : '请在电脑的远程授权中授予辅助功能权限');
        const result = await this.dispatch(event.input);
        if (Number.isSafeInteger(event.token)) this.registry.inputResult(this.peer, this.sessionId, event.token, result);
      } catch (error) { this.error = error.message; if (Number.isSafeInteger(event.token)) this.registry.inputResult(this.peer, this.sessionId, event.token, { error: error.message }); }
    }
  }
  async releaseInput() {
    if (this.platform === 'win32') {
      await this.helper.request({ op: 'release' }).catch(() => {});
      this.pointerDown = false;
    }
  }
  async dispatch(input) {
    if (input.kind === 'pointer') {
      const x = this.bounds.originX + Math.round(Math.max(0, Math.min(1, input.x)) * (this.bounds.width - 1));
      const y = this.bounds.originY + Math.round(Math.max(0, Math.min(1, input.y)) * (this.bounds.height - 1));
      if (input.action === 'wheel') { await this.helper.request({ op: 'move', x, y }); return this.helper.request({ op: 'wheel', deltaX: input.deltaX, deltaY: input.deltaY }); }
      const op = input.action === 'move' && this.pointerDown ? 'drag' : input.action;
      this.lastPointer = { x, y };
      if (input.action === 'down') { this.pointerDown = true; this.pointerButton = input.button; }
      if (input.action === 'up') this.pointerDown = false;
      return this.helper.request({ op, x, y, button: input.button, click: input.click || 1 });
    }
    if (input.text && !input.key && !input.code) return this.helper.request({ op: 'text', text: input.text });
    return this.helper.request({ op: 'key', action: input.action, code: input.code || input.key, modifiers: input.modifiers });
  }
  async handle(req, res) {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (!['/api/remote-authorization', '/api/remote-authorization/status'].includes(pathname)) return false;
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!req.headers['x-agentroam-device-id']) { send(401, { error: '请先完成设备配对' }); return true; }
    if (pathname === '/api/remote-authorization/status') {
      if (req.method !== 'GET') { send(405, { error: 'Method not allowed' }); return true; }
      try {
        const { platform, supported, installed, enabled, screen, accessibility, online } = await this.status(false);
        send(200, { local: false, platform, supported, installed, enabled, screen, accessibility, online });
      } catch { send(503, { error: '暂时无法读取远程桌面状态' }); }
      return true;
    }
    if (!isLocalAuthorizationRequest(req)) { send(403, { local: false, error: '请在运行 CLI 的电脑上打开本机 /web 进行远程授权' }); return true; }
    try {
      if (req.method === 'GET') send(200, await this.status());
      else if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('需要 JSON 请求');
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1024) throw new Error('请求过大'); }
        const { action, permission } = JSON.parse(body);
        // Every manual retry immediately probes permissions again.
        this.lastPermissionCheck = 0;
        send(200, await this.action(action, permission));
      } else send(405, { error: 'Method not allowed' });
    } catch (error) { send(400, { error: error.message }); }
    return true;
  }
  async close() { clearInterval(this.timer); this.enabled = false; await this.video.stop(); this.registry.disconnect(this.peer); await this.helper.stop(); }
}
