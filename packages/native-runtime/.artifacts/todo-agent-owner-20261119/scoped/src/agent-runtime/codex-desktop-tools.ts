import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { resolve, win32 } from "node:path";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
interface Tool { name: string; namespace: string }
export interface DesktopTurn {
  id: string;
  status: string;
  error?: { message?: string } | null;
  items: Array<{ id?: string; type: string; text?: string; phase?: string; content?: Array<{ type: string; text?: string }> }>;
}
export interface DesktopThreadSnapshot {
  thread: { id: string; kind: string; cwd?: string; status?: { type: string; activeFlags?: string[] } };
  turns: DesktopTurn[];
}
export interface CodexDesktopConnection {
  read(): Promise<DesktopThreadSnapshot>;
  send(prompt: string, options?: { model?: string; thinking?: string; callId?: string }): Promise<void>;
  close(): void;
}

/** Borrow the running Desktop's app tools; never create a second thread writer. */
export class CodexDesktopTools {
  constructor(private readonly options: {
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    pipePaths?: () => Promise<string[]>;
    timeoutMs?: number;
  } = {}) {}

  async connect(threadId: string, cwd: string): Promise<CodexDesktopConnection | null> {
    if ((this.options.platform ?? process.platform) !== "win32") return null;
    const environment = this.options.environment ?? process.env;
    let paths: string[];
    if (environment.AGENT_CODEX_DESKTOP_BRIDGE === "0") return null;
    const explicit = environment.CODEX_APP_TOOLS_PIPE_PATH?.trim();
    try {
      paths = this.options.pipePaths ? await this.options.pipePaths()
        : explicit ? [explicit]
        : (this.options.platform ?? process.platform) === "win32"
          ? (await readdir("\\\\.\\pipe\\")).filter(name => /^codex-app-tools-[\da-f-]+$/i.test(name))
            .slice(0, 8).map(name => `\\\\.\\pipe\\${name}`)
          : [];
    } catch { return null; }
    for (const path of paths) {
      const rpc = new DesktopPipe(path, this.options.timeoutMs ?? 10_000);
      try {
        const catalog = await rpc.request("tools/list", { threadStartKind: "all" }) as { tools?: Tool[] };
        const tools = catalog.tools ?? [];
        const read = tools.find(tool => tool.name === "read_thread");
        const send = tools.find(tool => tool.name === "send_message_to_thread");
        if (!read?.namespace || !send?.namespace) throw new Error("Desktop tools unavailable");
        const invoke = async (tool: Tool, args: object, callId: string = randomUUID()) => {
          // The native thread is the app-tools routing context for this paired
          // user's action. No assistant prompt is executed to relay the message.
          const result = await rpc.request("tools/call", {
            arguments: args, namespace: tool.namespace, tool: tool.name,
            callerSource: "codex", threadId, callId: `agentroam-${callId}`, turnId: `agentroam-${callId}`,
          }) as { success?: boolean; contentItems?: Array<{ type: string; text?: string }> };
          const text = result.contentItems?.filter(item => item.type === "inputText").map(item => item.text ?? "").join("\n") ?? "";
          if (!result.success) throw new Error(text || "Codex Desktop rejected the request");
          return text;
        };
        const connection: CodexDesktopConnection = {
          read: async () => {
            const snapshot = JSON.parse(await invoke(read, { threadId, hostId: "local", turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 20_000 })) as DesktopThreadSnapshot;
            if (snapshot.thread?.id !== threadId || snapshot.thread.kind !== "codex" || !Array.isArray(snapshot.turns)) {
              throw new Error("Codex Desktop returned a different conversation");
            }
            return snapshot;
          },
          send: async (prompt, options = {}) => {
            // Never retry a mutation: a lost response does not prove that the
            // original message was rejected. The native history is authoritative.
            await invoke(send, {
              threadId, hostId: "local", prompt,
              ...(options.model ? { model: options.model } : {}),
              ...(options.thinking ? { thinking: options.thinking } : {}),
            }, options.callId);
          },
          close: () => rpc.close(),
        };
        const snapshot = await connection.read();
        const canonical = (path: string) => (this.options.platform ?? process.platform) === "win32"
          ? win32.resolve(path).toLowerCase() : resolve(path);
        if (!snapshot.thread.cwd || canonical(snapshot.thread.cwd) !== canonical(cwd)) {
          throw new Error("Codex Desktop workspace does not match the requested conversation");
        }
        return connection;
      } catch { rpc.close(); }
    }
    return null;
  }
}

/** Length-prefixed JSON-RPC, matching the bundled Codex app-tools transport. */
class DesktopPipe {
  private socket: Socket | null = null;
  private connecting?: Promise<Socket>;
  private data = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly path: string, private readonly timeoutMs: number) {}

  async request(method: string, params: unknown): Promise<unknown> {
    const socket = await this.connect();
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    if (payload.length > MAX_FRAME_BYTES) throw new Error("Codex Desktop request is too large");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Closing also rejects other pending reads and prevents late replies
        // from being mistaken for an acknowledgement of a later send.
        this.close();
        reject(new Error("Codex Desktop response timed out; check the original conversation before retrying"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(frame, error => { if (error) this.close(); });
    });
  }

  close(): void {
    this.socket?.destroy(); this.socket = null;
    this.data = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error("Codex Desktop connection closed"));
    }
    this.pending.clear();
  }

  private connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.path);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Codex Desktop connection timed out")); }, Math.min(this.timeoutMs, 2_000));
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("connect", () => {
        clearTimeout(timer); this.socket = socket;
        socket.on("data", chunk => this.receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
        socket.on("error", () => this.close());
        socket.on("close", () => { if (this.socket === socket) this.close(); });
        resolve(socket);
      });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private receive(chunk: Buffer): void {
    this.data = Buffer.concat([this.data, chunk]);
    while (this.data.length >= 4) {
      const length = this.data.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) { this.close(); return; }
      if (this.data.length < length + 4) return;
      try {
        const reply = JSON.parse(this.data.subarray(4, length + 4).toString("utf8"));
        this.data = this.data.subarray(length + 4);
        if (reply.jsonrpc !== "2.0" || typeof reply.id !== "number") throw new Error("Invalid app-tools response");
        const pending = this.pending.get(reply.id);
        if (!pending) continue;
        this.pending.delete(reply.id); clearTimeout(pending.timer);
        if (reply.error) pending.reject(new Error(reply.error.message || "Codex Desktop request failed"));
        else pending.resolve(reply.result);
      } catch { this.close(); return; }
    }
  }
}
