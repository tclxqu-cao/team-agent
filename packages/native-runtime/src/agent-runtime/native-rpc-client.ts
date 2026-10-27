import { randomUUID } from "node:crypto";
import { NativeStdioChannel, type NativeJsonPacket, type NativeStdioCommand } from "./native-stdio-channel.js";
import { RuntimeSessionError } from "./types.js";

export interface NativeRpcConnection {
  request(method: string, params: NativeJsonPacket, timeoutMs?: number): Promise<NativeJsonPacket>;
  notify(method: string, params: NativeJsonPacket): Promise<void>;
  onNotification(listener: (method: string, params: NativeJsonPacket) => void): () => void;
  onRequest(handler: (method: string, params: NativeJsonPacket) => Promise<unknown>): void;
  onFailure(listener: (error: RuntimeSessionError) => void): () => void;
  dispose(): Promise<void>;
}

export function nativeRecord(value: unknown): NativeJsonPacket {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as NativeJsonPacket : {};
}

/** JSON-RPC envelopes only; session, permission and model semantics belong to each client. */
export class NativeRpcClient implements NativeRpcConnection {
  private channel: Promise<NativeStdioChannel> | null = null;
  private recovery: Promise<void> | null = null;
  private readonly notifications = new Set<(method: string, params: NativeJsonPacket) => void>();
  private readonly failures = new Set<(error: RuntimeSessionError) => void>();
  private requestHandler: ((method: string, params: NativeJsonPacket) => Promise<unknown>) | null = null;
  private disposed = false;

  constructor(private readonly command: () => Promise<NativeStdioCommand>, private readonly jsonrpc = true) {}

  private envelope(packet: NativeJsonPacket): NativeJsonPacket { return this.jsonrpc ? { jsonrpc: "2.0", ...packet } : packet; }

  private connection(): Promise<NativeStdioChannel> {
    if (this.disposed) return Promise.reject(new RuntimeSessionError("Native RPC client is disposed", "RUNTIME_UNAVAILABLE"));
    if (this.recovery) return this.recovery.then(() => this.connection());
    if (this.channel) return this.channel;
    const connection = this.command().then(command => {
      const channel = new NativeStdioChannel({ ...command,
        responseKey: packet => packet.method === undefined && ("result" in packet || "error" in packet)
          && (typeof packet.id === "string" || typeof packet.id === "number") ? String(packet.id) : undefined,
        onPacket: async packet => {
          if (typeof packet.method !== "string") return;
          const params = nativeRecord(packet.params);
          if (packet.id === undefined) {
            for (const listener of this.notifications) listener(packet.method, params);
            return;
          }
          try {
            if (!this.requestHandler) throw new Error("Unsupported native callback");
            const result = await this.requestHandler(packet.method, params);
            await channel.send(this.envelope({ id: packet.id, result }));
          } catch {
            await channel.send(this.envelope({ id: packet.id, error: { code: -32601, message: "Unsupported native callback" } }));
          }
        },
        onFailure: error => {
          for (const listener of this.failures) listener(error);
          if (this.disposed) return;
          const recovery = channel.dispose().finally(() => {
            if (this.channel === connection) this.channel = null;
            if (this.recovery === recovery) this.recovery = null;
          });
          this.recovery = recovery;
        },
      });
      return channel;
    }).catch(error => { this.channel = null; throw error; });
    this.channel = connection;
    return connection;
  }

  async request(method: string, params: NativeJsonPacket, timeoutMs?: number): Promise<NativeJsonPacket> {
    const channel = await this.connection();
    const id = randomUUID();
    const packet = await channel.request(id, this.envelope({ id, method, params }), timeoutMs);
    if (packet.error !== undefined) {
      const error = nativeRecord(packet.error);
      throw new RuntimeSessionError(typeof error.message === "string" ? error.message : "Native RPC request failed", "NATIVE_PROTOCOL_ERROR");
    }
    return nativeRecord(packet.result);
  }

  async notify(method: string, params: NativeJsonPacket): Promise<void> {
    await (await this.connection()).send(this.envelope({ method, params }));
  }

  onNotification(listener: (method: string, params: NativeJsonPacket) => void) { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onRequest(handler: (method: string, params: NativeJsonPacket) => Promise<unknown>) { this.requestHandler = handler; }
  onFailure(listener: (error: RuntimeSessionError) => void) { this.failures.add(listener); return () => { this.failures.delete(listener); }; }

  async dispose(): Promise<void> {
    this.disposed = true;
    await (await this.channel?.catch(() => null))?.dispose();
    await this.recovery;
    this.notifications.clear();
    this.failures.clear();
  }
}
