import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { chromeHubSiteForUrl, isChromeHubSite, validChromeConversation, chromeHubErrorMessage, type ChromeHubConversation, type ChromeHubFrame, type ChromeHubStatus, type ChromeHubTab } from "./chrome-bridge-protocol.js";

export type ChromeBridgeEvent =
  | { type: "chrome-status"; status: ChromeHubStatus }
  | { type: "chrome-conversation"; conversation: ChromeHubConversation }
  | { type: "chrome-page-error"; siteId: string; error: string }
  | { type: "chrome-frame"; frame: ChromeHubFrame };

/** Only the local extension with the pairing secret can control explicitly attached provider tabs. */
export class ChromeHubBridge {
  private server: WebSocketServer | null = null;
  private peer: WebSocket | null = null;
  private port = 0;
  private readonly token: string;
  private readonly tabs = new Map<string, ChromeHubTab>();
  private readonly frames = new Map<string, ChromeHubFrame>();
  private readonly conversations = new Map<string, ChromeHubConversation>();
  private compatible = false;
  private paused = false;
  private autoConnectControl = false;
  private readonly pending = new Map<number, { siteId: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private readonly listeners = new Set<(event: ChromeBridgeEvent) => void>();

  constructor(private readonly statePath: string) {
    let saved: { token?: string } = {};
    try { saved = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first use */ }
    this.token = typeof saved.token === "string" && /^[a-f0-9]{64}$/.test(saved.token) ? saved.token : randomBytes(32).toString("hex");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ token: this.token }), { mode: 0o600 });
    chmodSync(statePath, 0o600);
  }

  async start(port = 19473): Promise<void> {
    if (this.server) return;
    const server = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 8 * 1024 * 1024 });
    this.server = server;
    server.on("connection", (socket, request) => {
      if (!/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin ?? "")) { socket.close(1008); return; }
      let authenticated = false;
      const deadline = setTimeout(() => socket.close(1008), 5000);
      socket.on("error", () => socket.close());
      socket.on("close", () => { clearTimeout(deadline); if (this.peer === socket) this.disconnect(); });
      socket.on("message", (data) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(data.toString()); } catch { socket.close(1008); return; }
        if (!message || typeof message !== "object") { socket.close(1008); return; }
        if (!authenticated) {
          const candidate = typeof message.token === "string" ? Buffer.from(message.token) : Buffer.alloc(0);
          const expected = Buffer.from(this.token);
          if (message.type !== "hello" || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) { socket.close(1008); return; }
          if (this.peer && this.peer !== socket) { socket.close(1008); return; }
          clearTimeout(deadline);
          authenticated = true;
          this.peer = socket;
          this.compatible = Array.isArray(message.capabilities) && message.capabilities.includes("conversations-v1");
          this.autoConnectControl = Array.isArray(message.capabilities) && message.capabilities.includes("auto-connect-control-v1");
          socket.send(JSON.stringify({ type: "ready" }));
          this.emitStatus();
          return;
        }
        this.receive(message);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }).catch((error) => { this.server = null; throw error; });
    this.port = (server.address() as { port: number }).port;
  }

  pairingCode(): string {
    if (!this.port) throw new Error("chrome-bridge-unavailable");
    return `aihub:${this.port}:${this.token}`;
  }
  status(): ChromeHubStatus { return { connected: this.peer?.readyState === WebSocket.OPEN, tabs: [...this.tabs.values()], compatible: this.compatible, paused: this.paused }; }
  conversation(siteId: string): ChromeHubConversation | null { return this.conversations.get(siteId) ?? null; }
  frame(siteId: string): ChromeHubFrame | null { return this.frames.get(siteId) ?? null; }
  subscribe(listener: (event: ChromeBridgeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: ChromeBridgeEvent): void { for (const listener of this.listeners) listener(event); }
  private emitStatus(): void { this.emit({ type: "chrome-status", status: this.status() }); }

  private receive(message: Record<string, unknown>): void {
    if (message.type === "ping") { this.peer?.send(JSON.stringify({ type: "pong" })); return; }
    if (message.type === "auto-connect-status" && this.autoConnectControl && typeof message.paused === "boolean") {
      this.paused = message.paused;
      this.emitStatus();
      return;
    }
    if (message.type === "reply" && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok === true) pending.resolve(message.result);
      else pending.reject(new Error(typeof message.error === "string" ? message.error.slice(0, 160) : "chrome-command-failed"));
      return;
    }
    const siteId = message.siteId;
    if (typeof siteId !== "string" || !isChromeHubSite(siteId)) return;
    if (message.type === "tab") {
      if (!Number.isInteger(message.tabId) || typeof message.url !== "string" || chromeHubSiteForUrl(message.url) !== siteId) return;
      this.conversations.delete(siteId);
      if (this.tabs.delete(siteId)) this.emitStatus();
      this.tabs.set(siteId, { siteId, tabId: Number(message.tabId), url: new URL(message.url).origin });
      this.emitStatus();

    } else if (message.type === "detached") {
      this.tabs.delete(siteId);
      for (const [id, pending] of this.pending) {
        if (pending.siteId !== siteId) continue;
        clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error("Chrome 标签页已断开"));
      }
      this.frames.delete(siteId);
      this.conversations.delete(siteId);
      this.emitStatus();
    } else if (message.type === "page-error" && this.tabs.has(siteId) && message.error === "chrome-conversation-unavailable") {
      this.emit({ type: "chrome-page-error", siteId, error: chromeHubErrorMessage(message.error) });
    } else if (message.type === "conversation" && this.compatible && this.tabs.has(siteId) && validChromeConversation(message.conversation)) {
      const conversation = { ...(message.conversation as Omit<ChromeHubConversation, "siteId" | "receivedAt">), siteId, receivedAt: Date.now() };
      const previous = this.conversations.get(siteId);
      if (previous && previous.revision >= conversation.revision) return;
      this.conversations.set(siteId, conversation);
      this.emit({ type: "chrome-conversation", conversation });
    }
  }

  request(siteId: string, command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.peer || this.peer.readyState !== WebSocket.OPEN || !this.tabs.has(siteId)) return Promise.reject(new Error("请在 Chrome 打开并登录该站点，等待扩展自动连接"));
    if (this.paused) return Promise.reject(new Error("Chrome 连接已暂停，请点击恢复连接"));
    if (!this.compatible) return Promise.reject(new Error("请从桌面端加载 0.3.0 版自动连接扩展"));
    return this.dispatch(siteId, command, payload);
  }
  async resume(): Promise<ChromeHubStatus> {
    if (!this.peer || this.peer.readyState !== WebSocket.OPEN) throw new Error("扩展未连接，请确认日常 Chrome 已打开且扩展已启用");
    if (!this.autoConnectControl) throw new Error("请在 Chrome 扩展管理页刷新 AI Hub 扩展后重试");
    await this.dispatch("", "resume-auto-connect", {});
    return this.status();
  }
  private dispatch(siteId: string, command: string, payload: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Chrome 操作超时，请检查标签页")); }, command === "send-message" || command === "resume-auto-connect" ? 30_000 : 10_000);
      this.pending.set(id, { siteId, resolve, reject, timer });
      this.peer!.send(JSON.stringify({ type: "command", id, siteId, command, payload }), (error) => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(new Error("Chrome 连接已断开"));
      });
    });
  }
  private disconnect(): void {
    this.peer = null; this.compatible = false; this.paused = false; this.autoConnectControl = false; this.tabs.clear(); this.frames.clear(); this.conversations.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Chrome 连接已断开")); }
    this.pending.clear(); this.emitStatus();
  }
  close(): void {
    for (const client of this.server?.clients ?? []) client.terminate();
    this.server?.close(); this.server = null; this.port = 0; this.disconnect();
  }
}
