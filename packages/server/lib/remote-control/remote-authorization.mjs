import { WindowsRemoteHelper } from './windows-helper.mjs';
import { WindowsSystemBridge } from './windows-system-bridge.mjs';
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
  constructor({ registry, userId, dataDir, platform = process.platform, helper = platform === 'win32' ? new WindowsRemoteHelper() : new RemoteHelper(), supported = supportsRemoteDesktop(platform), intervalMs = 150, idleDelayMs = 3000, system = platform === 'win32' ? new WindowsSystemBridge() : null }) {
    Object.assign(this, { registry, dataDir, helper, supported, intervalMs, idleDelayMs, platform, system });
    this.enabled = false; this.screen = false; this.accessibility = false; this.online = false; this.error = null; this.busy = false; this.sequence = 0; this.generation = 0;
    this.locked = null; this.unavailablePublished = null; this.viewerCount = 0; this.captureActive = false; this.idleTimer = null;
    this.sessionId = 'cli-desktop:primary';
    this.peer = { id: `cli-remote:${randomUUID()}`, userId, producerSessionIds: new Set(), watchedSessionId: null, send: (event) => {
      const generation = this.switching ? -1 : this.generation;
      this.inputQueue = this.inputQueue.then(() => this.onEvent(event, generation)).catch((error) => { this.error = error.message; });
    } };
    this.inputQueue = Promise.resolve();
    // WebRTC signaling chain: a start waits for ICE gathering (a slow STUN
    // round trip on constrained networks), so it must never occupy the
    // serialized event queue — takeovers, returns and inputs would inherit
    // that delay. Events here keep their relative order.
    this.mediaChain = Promise.resolve();
    this.video = new RemoteWebrtcVideo({ helper, signal: data => { if (this.enabled && this.online) this.registry.webrtcFromProducer(this.peer, this.sessionId, data); } });
    this.stateFile = join(dataDir, 'remote-authorization.json');
  }
  async initialize() {
    if (!this.supported) return;
    try { this.enabled = JSON.parse(await readFile(this.stateFile, 'utf8')).enabled === true; } catch {}
    this.registry.connect(this.peer);
    if (this.enabled) this.publishDormant();
    this.timer = setInterval(() => { if (this.enabled && this.captureActive && this.viewerCount > 0) void this.tick(); }, this.intervalMs); this.timer.unref();
  }
  async status(local = true) {
    const unlock = this.platform === 'win32' && this.system ? await this.system.probe().then(p => p.available ? 'available' : 'missing').catch(() => 'missing') : 'unsupported';
    return { local, platform: this.platform, supported: this.supported, installed: this.supported && await this.helper.available(), enabled: this.enabled, screen: this.screen, accessibility: this.accessibility, online: this.online, error: this.error, locked: this.locked, unlock };
  }
  /** Lock / wake / unlock entry point for paired remote viewers (`browser:system`). */
  async systemAction(action, { password, sessionId } = {}) {
    if (!['lock', 'wake', 'unlock'].includes(action)) throw new Error('未知系统操作');
    if (this.platform !== 'win32' || !this.system) throw new Error('远程系统控制目前仅支持 Windows 10/11 x64');
    if (!this.enabled) throw new Error('请先在电脑上开启远程桌面共享');
    if (sessionId !== this.sessionId) throw new Error('远程桌面会话已失效，请刷新后重试');
    if (action === 'lock') {
      await this.helper.start();
      return this.helper.request({ op: 'lock' });
    }
    // Wake goes through the user helper on an unlocked desktop; a locked
    // session needs the unlock service to inject input on the secure desktop.
    if (action === 'wake') {
      await this.helper.start().catch(() => {});
      const permissions = await this.helper.request({ op: 'status' }).catch(() => null);
      if (permissions && permissions.locked !== true) return this.helper.request({ op: 'wake' });
      const probe = await this.system.probe().catch(() => null);
      if (!probe?.available) throw new Error('远程解锁服务不可用，请在 Windows 电脑上运行 agentroam unlock-service install');
      return this.system.wake();
    }
    const result = await this.system.unlock(password);
    // Resume video capture promptly once the desktop comes back.
    this.lastPermissionCheck = 0; this.retryAt = 0;
    return result;
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
      this.applyPermissions(permissions);
      this.lastPermissionCheck = Date.now();
      if (!this.captureActive) await this.helper.stop();
      if (this.enabled && !this.captureActive) this.publishDormant();
      return this.status();
    }
    this.generation += 1;
    this.lastPermissionCheck = 0;
    if (action === 'disable') {
      this.enabled = false; this.captureActive = false; this.viewerCount = 0; this.clearIdleTimer(); await this.video.stop(); await this.save();
      if (this.online) this.registry.close(this.peer, this.sessionId);
      this.online = false; await this.helper.stop();
    } else {
      this.enabled = true; this.retryAt = 0; await this.save();
      if (action === 'restart') { await this.video.stop(); await this.helper.stop(); }
      await this.helper.start();
      if (action === 'authorize') await this.helper.request({ op: 'authorize', permission });
      const permissions = await this.helper.request({ op: 'status' });
      this.applyPermissions(permissions); this.lastPermissionCheck = Date.now();
      this.error = this.screen ? null : (permissions.error || (this.platform === 'win32' ? 'Windows 桌面暂不可用' : '请先授予屏幕录制权限'));
      if (this.viewerCount > 0) {
        this.captureActive = true;
        await this.tick();
      } else {
        await this.helper.stop();
        this.publishDormant();
      }
    }
    return this.status();
  }
  tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.captureTick().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }
  async captureTick() {
    if (this.switching || this.busy || !this.enabled || !this.captureActive || this.viewerCount < 1 || Date.now() < (this.retryAt || 0)) return;
    this.busy = true;
    const generation = this.generation;
    try {
      await this.helper.start();
      if (!this.enabled || generation !== this.generation) return;
      // Permissions need not be polled at the frame rate.
      if (!this.lastPermissionCheck || Date.now() - this.lastPermissionCheck > 2000) {
        const permissions = await this.helper.request({ op: 'status' });
        this.applyPermissions(permissions);
        this.lastPermissionCheck = Date.now();
        if (!this.screen) this.error = permissions.error || (this.platform === 'win32' ? '请在 Windows 上恢复已登录的普通桌面' : '请先授予屏幕录制权限');
      }
      if (!this.screen) {
        this.bounds = null; await this.releaseInput(); await this.video.stop();
        // A locked Windows session keeps the CLI alive: keep the session card
        // visible (as unavailable) so a paired viewer can still wake or unlock
        // the machine instead of losing the entry point entirely.
        this.publishUnavailable(this.error, this.locked === true);
        return;
      }
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
      this.publishUnavailable(this.error, this.locked === true);
    } finally { this.busy = false; }
  }
  /** Publishes the locked/unavailable state once per transition so viewers
   *  keep a surface for wake/unlock actions (Windows keeps `online` true). */
  publishUnavailable(error, locked) {
    const signature = JSON.stringify([Boolean(locked), error]);
    if (this.unavailablePublished === signature) return;
    this.unavailablePublished = signature;
    const capabilityError = locked ? 'Windows 已锁屏' : (error || '桌面暂不可用');
    const capabilityErrorCode = locked ? 'desktop-locked' : 'desktop-unavailable';
    if (!this.online) {
      this.registry.publish(this.peer, {
        sessionId: this.sessionId, backend: 'desktop', title: '本机桌面', url: '', viewport: this.viewport,
        transport: 'cdp-jpeg-ws', availability: 'unavailable', platform: this.platform,
        capabilityError, capabilityErrorCode,
      });
      this.online = true;
    } else {
      this.registry.updateAvailability(this.peer, this.sessionId, {
        availability: 'unavailable', capabilityError, capabilityErrorCode, clearFrame: true,
      });
    }
  }
  applyPermissions(permissions) {
    this.screen = permissions.screen === true; this.accessibility = permissions.accessibility === true;
    this.locked = permissions.locked === true;
  }
  publishDormant() {
    if (!this.enabled) return;
    this.unavailablePublished = null;
    const unavailable = Boolean(this.lastPermissionCheck && !this.screen);
    const input = {
      sessionId: this.sessionId, backend: 'desktop', title: '本机桌面', url: '', viewport: this.viewport,
      displays: this.displays, transport: 'cdp-jpeg-ws', platform: this.platform,
      availability: unavailable ? 'unavailable' : 'starting',
      ...(unavailable ? {
        capabilityError: this.error || (this.platform === 'win32' ? 'Windows 桌面暂不可用' : '请先授予屏幕录制权限'),
        capabilityErrorCode: this.locked ? 'desktop-locked' : 'desktop-unavailable',
      } : {}),
    };
    this.registry.publish(this.peer, input);
    this.online = true;
    this.registry.updateAvailability(this.peer, this.sessionId, {
      availability: input.availability,
      capabilityError: input.capabilityError,
      capabilityErrorCode: input.capabilityErrorCode,
      clearFrame: true,
    });
  }
  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  async updateViewerCount(value) {
    const count = Number.isSafeInteger(value) && value > 0 ? value : 0;
    this.viewerCount = count;
    if (count > 0) {
      this.clearIdleTimer();
      if (!this.captureActive) {
        this.captureActive = true; this.retryAt = 0;
        await this.tick();
      }
      return;
    }
    if (!this.captureActive || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.inputQueue = this.inputQueue.then(() => this.stopIdleCapture()).catch((error) => { this.error = error.message; });
    }, this.idleDelayMs);
    this.idleTimer.unref?.();
  }
  async stopIdleCapture() {
    if (!this.enabled || this.viewerCount > 0 || !this.captureActive) return;
    this.captureActive = false; this.generation += 1; this.bounds = null;
    await this.releaseInput();
    await this.video.stop();
    await this.helper.request({ op: 'stop-capture' }).catch(() => {});
    await this.helper.stop();
    await this.tickPromise?.catch(() => {});
    this.publishDormant();
  }
  publishFrame(frame) {
    this.unavailablePublished = null;
    this.viewport = { width: frame.width, height: frame.height, deviceScaleFactor: 1 }; this.bounds = frame;
    const previousQuality = this.quality;
    this.quality = frame.quality ?? this.quality ?? 'hd';
    const displays = frame.displays ?? this.displays ?? null;
    if (!this.online || JSON.stringify(displays) !== JSON.stringify(this.displays)) {
      this.displays = displays;
      this.registry.publish(this.peer, { sessionId: this.sessionId, backend: 'desktop', title: '本机桌面', url: '', viewport: this.viewport, displays, transport: 'cdp-jpeg-ws', platform: this.platform });
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
    const result = await this.reconfigureCapture({ op: 'set-quality', quality });
    this.video.setQuality(quality);
    return result;
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
    const eventSessionId = event.sessionId ?? event.session?.id;
    if (!this.enabled || eventSessionId !== this.sessionId) return;
    if (event.type === 'browser:state') { await this.updateViewerCount(event.session?.viewerCount); return; }
    if (event.type === 'browser:set-display') { await this.setDisplay(event.displayId); return; }
    if (event.type === 'browser:webrtc') {
      const signalQuality = (error) => this.registry.webrtcFromProducer(this.peer, this.sessionId, { kind: 'quality-state', quality: this.quality || 'hd', ...(error ? { error } : {}) });
      if (event.data.kind === 'quality') {
        try { await this.setQuality(event.data.quality); if (this.enabled && this.online) signalQuality(); }
        catch (error) { this.error = error.message; if (this.enabled && this.online) signalQuality(error.message); }
        return;
      }
      // Viewer cleanup fires stop on every unwatch/reload; tearing down in the
      // background keeps the queue free (a full werift close takes seconds).
      if (event.data.kind === 'stop') { void this.mediaChain.then(() => this.video.stop()).catch(() => {}); return; }
      // answer/ice handlers block inside werift until the offer's ICE gathering
      // settles (a slow STUN round trip can take ~10s) — they must share the
      // media chain with start instead of stalling the serialized event queue.
      if (event.data.kind === 'start') signalQuality();
      this.mediaChain = this.mediaChain.then(() => this.video.handle(event.data)).catch(() => {});
      return;
    }
    if (event.type === 'browser:takeover-requested') {
      if (this.platform === 'win32') void this.helper.request({ op: 'keep-display', on: true }).catch(() => {});
      this.registry.producerState(this.peer, this.sessionId, 'user-controlled');
    }
    else if (event.type === 'browser:return-requested') {
      if (this.platform === 'win32') void this.helper.request({ op: 'keep-display', on: false }).catch(() => {});
      // Media teardown (helper round trip + werift close) takes seconds; the
      // serialized queue must not inherit that delay — a queued takeover
      // confirm or input hit-test would otherwise stall behind it. Chaining
      // behind pending signaling keeps the teardown ordered after any start.
      void this.releaseInput().catch(() => {});
      void this.mediaChain.then(() => this.video.stop()).catch(() => {});
      this.registry.producerState(this.peer, this.sessionId, 'agent-controlled');
    }
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
        const { platform, supported, installed, enabled, screen, accessibility, online, locked, unlock } = await this.status(false);
        send(200, { local: false, platform, supported, installed, enabled, screen, accessibility, online, locked, unlock });
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
  async close() {
    clearInterval(this.timer); this.clearIdleTimer(); this.enabled = false; this.captureActive = false; this.generation += 1;
    const cleanup = Promise.allSettled([
      this.releaseInput(),
      this.video.stop(),
      this.helper.request({ op: 'stop-capture' }),
    ]);
    // Closing the owned helper socket rejects any native requests that are
    // stuck in flight, so service shutdown cannot wait behind media teardown.
    await this.helper.stop();
    await cleanup; await this.tickPromise?.catch(() => {}); this.registry.disconnect(this.peer);
  }
}
