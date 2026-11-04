import { randomUUID } from "node:crypto";
import { AhpClient, type AhpTransport } from "@microsoft/agent-host-protocol/client";
import { chatReducer, rootReducer, sessionReducer, SUPPORTED_PROTOCOL_VERSIONS,
  type ActionEnvelope, type ChatAction, type ChatState, type RootAction, type RootState,
  type SessionAction, type SessionState, type SessionSummary, type StateAction } from "@microsoft/agent-host-protocol";
import { VSCodeSocketTransport } from "./copilot-ahp-transport.js";
import type { VSCodeAgentEndpoint } from "./copilot-vscode-discovery.js";
import { RuntimeSessionError } from "./types.js";

type ChannelState = ChatState | SessionState | RootState;
interface Channel { state: ChannelState; seq: number }

/** Transport and reducers stay behind the native-runtime adapter port. */
export class CopilotAhpConnection {
  readonly clientId = `agentroam-${randomUUID()}`;
  readonly client: AhpClient;
  protocolVersion = "";
  private nextSeq = 1;
  private readonly channels = new Map<string, Channel>();
  private readonly subscribing = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(envelope: ActionEnvelope) => void>();
  private readonly closedListeners = new Set<() => void>();
  private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void }>();

  constructor(readonly instanceId: string, transport: AhpTransport, private readonly ackTimeout = 10_000) {
    this.client = new AhpClient(transport, { requestTimeoutMs: 10_000 });
  }

  static async open(endpoint: VSCodeAgentEndpoint): Promise<CopilotAhpConnection> {
    const connection = new CopilotAhpConnection(endpoint.instanceId, await VSCodeSocketTransport.open(endpoint));
    try { await connection.initialize(); return connection; }
    catch { await connection.dispose(); throw new RuntimeSessionError("VS Code Agent Host 协议连接失败，请升级 VS Code 并打开 Copilot 会话", "RUNTIME_UNAVAILABLE"); }
  }

  get connected(): boolean { return this.client.connectionState.status === "connected"; }
  get root(): RootState { return this.channels.get("ahp-root://")?.state as RootState ?? { agents: [] }; }
  get copilotProvider() { return this.root.agents.find(agent => ["copilotcli", "copilot"].includes(agent.provider)); }

  async initialize(): Promise<void> {
    const states = this.client.stateChanges();
    this.client.connect();
    void (async () => {
      for await (const state of states) if (state.status === "closed") {
        for (const pending of this.pending.values()) pending.reject(this.disconnected());
        this.pending.clear();
        for (const listener of this.closedListeners) listener();
      }
    })();
    const result = await this.client.initialize({ clientId: this.clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
    this.protocolVersion = result.protocolVersion;
    await this.subscribe("ahp-root://");
  }

  async subscribe(uri: string): Promise<void> {
    if (this.channels.has(uri)) return;
    const pending = this.subscribing.get(uri);
    if (pending) return pending;
    const request = (async () => {
      const { result, subscription } = await this.client.subscribe(uri);
      if (!result.snapshot) throw new RuntimeSessionError("VS Code 未返回会话快照", "NATIVE_PROTOCOL_ERROR");
      this.channels.set(uri, { state: result.snapshot.state as ChannelState, seq: result.snapshot.fromSeq });
      void (async () => {
        for await (const event of subscription) if (event.type === "action") this.apply(event.params);
      })().catch(() => this.client.shutdown());
    })();
    this.subscribing.set(uri, request);
    try { await request; } finally { this.subscribing.delete(uri); }
  }

  private apply(envelope: ActionEnvelope): void {
    if (envelope.origin?.clientId === this.clientId) {
      const pending = this.pending.get(envelope.origin.clientSeq);
      if (pending) {
        this.pending.delete(envelope.origin.clientSeq);
        if (envelope.rejectionReason) pending.reject(new RuntimeSessionError(`VS Code 拒绝操作：${envelope.rejectionReason}`, "NATIVE_PROTOCOL_ERROR"));
        else pending.resolve();
      }
    }
    const channel = this.channels.get(envelope.channel);
    if (!channel || envelope.rejectionReason || envelope.serverSeq <= channel.seq) return;
    const { action } = envelope;
    const state = envelope.channel.startsWith("ahp-chat:") ? chatReducer(channel.state as ChatState, action as ChatAction)
      : envelope.channel.startsWith("ahp-session:") ? sessionReducer(channel.state as SessionState, action as SessionAction)
      : rootReducer(channel.state as RootState, action as RootAction);
    this.channels.set(envelope.channel, { state, seq: envelope.serverSeq });
    for (const listener of this.listeners) listener(envelope);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.request("listSessions", { channel: "ahp-root://", ...(cursor ? { cursor } : {}) });
      sessions.push(...page.items);
      if (page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  }

  async session(uri: string): Promise<SessionState> { await this.subscribe(uri); return this.channels.get(uri)!.state as SessionState; }
  sessionState(uri: string): SessionState { return this.channels.get(uri)!.state as SessionState; }
  async chat(uri: string): Promise<ChatState> { await this.subscribe(uri); return this.chatState(uri); }
  chatState(uri: string): ChatState { return this.channels.get(uri)!.state as ChatState; }
  onAction(listener: (envelope: ActionEnvelope) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onClose(listener: () => void): () => void { this.closedListeners.add(listener); return () => this.closedListeners.delete(listener); }

  /** Wait for the server's authoritative echo. Timed-out mutations are NEVER replayed. */
  async dispatch(channel: string, action: StateAction): Promise<void> {
    await this.subscribe(channel);
    const seq = this.nextSeq++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.pending.set(seq, { resolve, reject });
        timer = setTimeout(() => reject(new RuntimeSessionError("VS Code 未确认操作结果，请刷新会话确认；未自动重发", "NATIVE_PROTOCOL_ERROR")), this.ackTimeout);
        this.client.dispatch(channel, action, seq);
      });
    } finally { clearTimeout(timer); this.pending.delete(seq); }
  }

  private disconnected() { return new RuntimeSessionError("VS Code Agent Host 连接已断开，请在原会话确认执行状态", "RUNTIME_UNAVAILABLE"); }
  async dispose(): Promise<void> { await this.client.shutdown(); }
}
