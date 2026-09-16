import net from 'node:net';

const PIPE_PATH = '\\\\.\\pipe\\agentroam-remote-unlock';
const MAX_RESPONSE = 64 * 1024;
const PROBE_TTL_MS = 10_000;
const PROBE_GRACE_MS = 60_000;
const UNLOCK_TIMEOUT_MS = 45_000;
const WAKE_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 3_000;

function defaultConnect() { return net.connect(PIPE_PATH); }

/** Named-pipe client for the AgentRoam unlock service (LocalSystem). Passwords
 *  are forwarded to the pipe and never logged, cached or persisted. Probes
 *  tolerate transient unavailability: while the service holds its single pipe
 *  instance busy (an unlock takes seconds), an existing success stays cached. */
export class WindowsSystemBridge {
  constructor({ connect = defaultConnect, probeTtlMs = PROBE_TTL_MS, platform = process.platform } = {}) {
    this.connect = connect;
    this.probeTtlMs = probeTtlMs;
    this.platform = platform;
    this.lastProbe = null;
  }

  get supported() { return this.platform === 'win32'; }

  /** Resolves { available, locked } from the service; throws when unreachable. */
  async probe() {
    const cached = this.lastProbe;
    if (cached && Date.now() - cached.at < this.probeTtlMs) return cached.value;
    try {
      const value = await this.status();
      this.lastProbe = { at: Date.now(), value };
      return value;
    } catch (error) {
      if (cached && Date.now() - cached.at < PROBE_GRACE_MS) return cached.value;
      throw error;
    }
  }

  async status() {
    const result = await this.request({ op: 'status' }, STATUS_TIMEOUT_MS);
    if (result.ok !== true) throw new Error(String(result.error || '远程解锁服务状态异常'));
    return { ...result, available: true, locked: result.locked === true };
  }

  async wake() {
    const result = await this.request({ op: 'wake' }, WAKE_TIMEOUT_MS);
    if (result.ok !== true) throw new Error(String(result.error || '唤醒屏幕失败'));
    return result;
  }

  async unlock(password) {
    if (typeof password !== 'string' || !password.length || password.length > 256) {
      throw new Error('请输入 1-256 位的 Windows 登录密码或 PIN');
    }
    let result;
    try {
      result = await this.request({ op: 'unlock', password }, UNLOCK_TIMEOUT_MS);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES' || /pipe/i.test(error.message)) {
        throw new Error('远程解锁服务不可用，请在 Windows 电脑上运行 agentroam unlock-service install');
      }
      throw error;
    }
    if (result.ok !== true) {
      const message = result.error === 'unlock-failed'
        ? '解锁失败：密码或 PIN 可能不正确；若启用了 Ctrl+Alt+Del 登录要求，请在电脑上手动解锁一次'
        : result.error === 'no-active-session'
          ? '当前没有已登录的 Windows 会话，无法远程解锁'
          : `远程解锁失败（${result.error || '未知错误'}）`;
      throw new Error(message);
    }
    return result;
  }

  request(payload, timeoutMs) {
    if (!this.supported) return Promise.reject(new Error('远程系统控制仅支持 Windows'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const socket = this.connect();
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('解锁服务响应超时')), timeoutMs);
      socket.on('error', fail);
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > MAX_RESPONSE) return fail(new Error('解锁服务响应过大'));
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        let result;
        try { result = JSON.parse(buffer.slice(0, end)); } catch { return fail(new Error('解锁服务响应无效')); }
        settled = true;
        clearTimeout(timer);
        socket.end();
        resolve(result);
      });
      socket.on('end', () => {
        if (!settled) fail(new Error('解锁服务提前断开连接'));
      });
      socket.write(JSON.stringify(payload) + '\n', (error) => { if (error) fail(error); });
    });
  }
}
