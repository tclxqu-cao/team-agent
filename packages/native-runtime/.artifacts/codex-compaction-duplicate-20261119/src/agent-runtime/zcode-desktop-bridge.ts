import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { nativeRecord, type NativeRpcConnection } from "./native-rpc-client.js";
import { ZCodeSteering } from "./zcode-steering.js";
import { RuntimeSessionError } from "./types.js";

export interface ZCodeDesktopTarget { id: string; cwd: string; workspaceIdentity?: string; readOnly?: boolean }
export interface ZCodeDesktopGuide {
  available(session: ZCodeDesktopTarget): Promise<boolean>;
  read?(session: ZCodeDesktopTarget): Promise<Record<string, unknown>>;
  steer(session: ZCodeDesktopTarget, input: string, messageId?: string): Promise<boolean>;
}
interface Descriptor { version: 1; protocol: string; hostId: string; pid: number; port: number; token: string }
const TIMEOUT_MS = 6_000;
const MAX_DESCRIPTOR_BYTES = 8 * 1024;

/** Borrow the desktop owner. This client never resumes or spawns its session. */
export class ZCodeDesktopBridge implements ZCodeDesktopGuide {
  private readonly directory: string;
  private readonly guides = new Map<string, ZCodeSteering>();
  private readonly owners = new Map<string, Descriptor>();
  constructor(private readonly options: { directory?: string; isAlive?: (pid: number) => boolean } = {}) {
    this.directory = options.directory ?? join(homedir(), ".zcode", "v2", "desktop-bridges");
  }

  private async descriptors(): Promise<Descriptor[]> {
    let names: string[];
    try { names = (await readdir(this.directory)).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).slice(0, 32); }
    catch { return []; }
    const rows = await Promise.all(names.map(async name => {
      let handle;
      try {
        handle = await open(join(this.directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_DESCRIPTOR_BYTES
          || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) return null;
        const value = JSON.parse(await handle.readFile("utf8"));
        if (value.version !== 1 || value.protocol !== "zcode-desktop-guide"
          || !Number.isSafeInteger(value.pid) || value.pid < 1
          || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
          || !/^[a-f0-9-]{36}$/.test(value.hostId) || !/^[a-f0-9]{64}$/.test(value.token)) return null;
        if (this.options.isAlive ? !this.options.isAlive(value.pid) : !alive(value.pid)) return null;
        return value as Descriptor;
      } catch { return null; }
      finally { await handle?.close(); }
    }));
    return rows.filter((row): row is Descriptor => row !== null);
  }

  private async request(descriptor: Descriptor, session: ZCodeDesktopTarget, method: string, params: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/guide`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId: descriptor.hostId, target: { sessionId: session.id, workspacePath: session.cwd,
        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
      }, method, params }),
    });
    if (!response.ok) throw new RuntimeSessionError("ZCode 桌面端未确认接收，原消息已保留", "NATIVE_PROTOCOL_ERROR");
    const body = nativeRecord(await response.json());
    return nativeRecord(body.result);
  }

  private async owner(session: ZCodeDesktopTarget): Promise<Descriptor | null> {
    if (session.readOnly || !session.id || !session.cwd) return null;
    const found = await Promise.all((await this.descriptors()).map(async descriptor => {
      try {
        const result = await this.request(descriptor, session, "probe", {});
        return result.supported === true && result.hostId === descriptor.hostId ? descriptor : null;
      } catch { return null; }
    }));
    // 两个 owner 都声称持有会话时不能任意选择一个执行者。
    const owners = found.filter((row): row is Descriptor => row !== null);
    const key = JSON.stringify([session.id, session.cwd, session.workspaceIdentity]);
    if (owners.length === 1) { this.owners.set(key, owners[0]!); return owners[0]!; }
    this.owners.delete(key);
    return null;
  }

  async available(session: ZCodeDesktopTarget): Promise<boolean> { return Boolean(await this.owner(session)); }

  async read(session: ZCodeDesktopTarget): Promise<Record<string, unknown>> {
    // A turn can finish between capability discovery and history read. Reading
    // its existing resident must still work; only command admission needs busy.
    const descriptor = this.owners.get(JSON.stringify([session.id, session.cwd, session.workspaceIdentity])) ?? await this.owner(session);
    if (!descriptor) throw new RuntimeSessionError("ZCode 桌面会话已不可用，请刷新后重试", "SESSION_OCCUPIED");
    const result = await this.request(descriptor, session, "read", {});
    if (nativeRecord(result.session).sessionId !== session.id) throw new RuntimeSessionError("ZCode 桌面会话身份不匹配", "NATIVE_PROTOCOL_ERROR");
    return result;
  }

  async steer(session: ZCodeDesktopTarget, input: string, messageId?: string): Promise<boolean> {
    if (!input.trim()) return false;
    const descriptor = await this.owner(session);
    if (!descriptor) throw new RuntimeSessionError("ZCode 桌面端连接不可用，原消息已保留", "SESSION_OCCUPIED");
    const key = JSON.stringify([descriptor.hostId, session.id, session.cwd, session.workspaceIdentity]);
    let guide = this.guides.get(key);
    if (!guide) {
      const rpc: NativeRpcConnection = {
        request: (method, params) => this.request(descriptor, session, method, params),
        notify: async () => {}, onNotification: () => () => {}, onRequest: () => {}, onFailure: () => () => {}, dispose: async () => {},
      };
      guide = new ZCodeSteering(rpc);
      this.guides.set(key, guide);
    }
    return guide.steer(session.id, input, messageId);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
