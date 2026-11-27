import type { AgentEvent, Message } from "@agent/core";
import { type NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { type CreateRuntimeSessionOptions, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";
import { QoderWorkspaceCatalog } from "./qoder-workspace-catalog.js";
import { QoderSessionHistory } from "./qoder-session-history.js";
import { type QoderModelCatalogLoader } from "./qoder-model-catalog.js";
import { type QoderActivityReader } from "./qoder-desktop-activity.js";
/** Qoder's ACP contract. No CA provider profile or native credential is copied. */
export declare class QoderClient implements NativeSessionProtocol {
    private readonly rpc;
    private readonly workspaces;
    private readonly historySource;
    private readonly modelCatalog;
    private readonly activity;
    private initializing;
    private readonly sessions;
    private readonly loaded;
    private readonly todoMcp;
    private mcpServers;
    private readonly unpersistedSessions;
    private readonly histories;
    private readonly historyLoads;
    private readonly runs;
    private readonly pendingTodoStarts;
    private readonly permissions;
    private models;
    private catalogModels;
    private readonly sessionModels;
    private modelLoad;
    private readonly unsubscribe;
    constructor(rpc?: NativeRpcConnection, workspaces?: Pick<QoderWorkspaceCatalog, "list">, historySource?: Pick<QoderSessionHistory, "read">, modelCatalog?: QoderModelCatalogLoader, activity?: QoderActivityReader);
    available(): Promise<void>;
    private session;
    list(): Promise<NativeProtocolSession[]>;
    private refreshActivity;
    private captureOptions;
    private load;
    private reload;
    read(id: string): Promise<{
        session: NativeProtocolSession;
        messages: Message[];
    }>;
    create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession>;
    restoreDraft(session: NativeProtocolSession): void;
    listModels(): Promise<RuntimeModelInfo[]>;
    private modelId;
    run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    abort(id: string): Promise<void>;
    private notification;
    private callback;
    private resolvePermission;
    private cancelPermissions;
    answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=qoder-client.d.ts.map