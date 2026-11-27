import { type AgentEvent } from "@agent/core";
import { type NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { type CreateRuntimeSessionOptions, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";
export declare const ACP_CLI_LABELS: {
    readonly grok: "Grok CLI";
    readonly agy: "Antigravity CLI";
};
export type AcpCliAgentType = keyof typeof ACP_CLI_LABELS;
/** ACP anti-corruption layer; native session IDs, permissions and credentials stay with the CLI. */
export declare class AcpCliClient implements NativeSessionProtocol {
    readonly agentType: AcpCliAgentType;
    private initialization?;
    private checking?;
    private checkedUntil;
    private readonly sessions;
    private readonly residents;
    private readonly loading;
    private readonly turns;
    private readonly permissions;
    private readonly questions;
    private readonly unsubscribe;
    private models;
    private imageSupported;
    private embeddedContextSupported;
    private disposed;
    private readonly localFiles?;
    private readonly rpc;
    constructor(agentType: AcpCliAgentType, connection?: NativeRpcConnection);
    private get label();
    available(): Promise<void>;
    private connect;
    private captureSession;
    private listPage;
    list(): Promise<NativeProtocolSession[]>;
    private open;
    private load;
    read(id: string): Promise<{
        session: NativeProtocolSession;
        messages: import("@agent/core").Message[];
    }>;
    create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession>;
    listModels(): Promise<RuntimeModelInfo[]>;
    private captureConfig;
    private setConfig;
    setMode(id: string, mode: string): Promise<void>;
    run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    private prompt;
    abort(id: string): Promise<void>;
    private notification;
    private callback;
    private ask;
    private finishQuestion;
    private settlePermission;
    private cancelInteractions;
    answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=acp-cli-client.d.ts.map