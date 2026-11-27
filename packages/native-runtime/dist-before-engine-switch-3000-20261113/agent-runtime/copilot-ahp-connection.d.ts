import { AhpClient, type AhpTransport } from "@microsoft/agent-host-protocol/client";
import { type ActionEnvelope, type ChatState, type RootState, type SessionState, type SessionSummary, type StateAction } from "@microsoft/agent-host-protocol";
import type { VSCodeAgentEndpoint } from "./copilot-vscode-discovery.js";
/** Transport and reducers stay behind the native-runtime adapter port. */
export declare class CopilotAhpConnection {
    readonly instanceId: string;
    private readonly ackTimeout;
    readonly clientId: string;
    readonly client: AhpClient;
    protocolVersion: string;
    private nextSeq;
    private readonly channels;
    private readonly subscribing;
    private readonly listeners;
    private readonly closedListeners;
    private readonly pending;
    constructor(instanceId: string, transport: AhpTransport, ackTimeout?: number);
    static open(endpoint: VSCodeAgentEndpoint): Promise<CopilotAhpConnection>;
    get connected(): boolean;
    get root(): RootState;
    get copilotProvider(): import("@microsoft/agent-host-protocol").AgentInfo | undefined;
    initialize(): Promise<void>;
    subscribe(uri: string): Promise<void>;
    private apply;
    listSessions(): Promise<SessionSummary[]>;
    session(uri: string): Promise<SessionState>;
    sessionState(uri: string): SessionState;
    chat(uri: string): Promise<ChatState>;
    chatState(uri: string): ChatState;
    onAction(listener: (envelope: ActionEnvelope) => void): () => void;
    onClose(listener: () => void): () => void;
    /** Wait for the server's authoritative echo. Timed-out mutations are NEVER replayed. */
    dispatch(channel: string, action: StateAction): Promise<void>;
    private disconnected;
    dispose(): Promise<void>;
}
//# sourceMappingURL=copilot-ahp-connection.d.ts.map