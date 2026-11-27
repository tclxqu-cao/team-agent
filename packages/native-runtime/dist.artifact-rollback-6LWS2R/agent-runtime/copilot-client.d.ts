import type { AgentEvent } from "@agent/core";
import { CopilotAhpConnection } from "./copilot-ahp-connection.js";
import { CopilotTodoTools } from "./copilot-todo-tools.js";
import { type VSCodeAgentEndpoint } from "./copilot-vscode-discovery.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { type CreateRuntimeSessionOptions, type RuntimeHealth, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";
export interface CopilotClientOptions {
    discover?: () => Promise<VSCodeAgentEndpoint[]>;
    connect?: (endpoint: VSCodeAgentEndpoint) => Promise<CopilotAhpConnection>;
    todoTools?: CopilotTodoTools;
}
/** Existing VS Code hosts own credentials, native sessions, tools and permissions. */
export declare class CopilotClient implements NativeSessionProtocol {
    private readonly options;
    private readonly hosts;
    private readonly catalog;
    private readonly drafts;
    private readonly running;
    private readonly steering;
    private readonly approvals;
    private readonly todoTools;
    private refreshing;
    constructor(options?: CopilotClientOptions);
    private refreshHosts;
    available(): Promise<void>;
    health(): Promise<RuntimeHealth>;
    list(): Promise<NativeProtocolSession[]>;
    private project;
    private locate;
    sessionSummary(id: string): Promise<NativeProtocolSession>;
    read(id: string): Promise<{
        session: NativeProtocolSession;
        messages: import("@agent/core").Message[];
        events: {
            type: "ask_user";
            questionId: string;
            question: string;
            options?: Array<{
                label: string;
                description: string;
            }>;
            fields?: Array<{
                name: string;
                label: string;
                description?: string;
                type?: "text" | "secret";
            }>;
            multiSelect?: boolean;
        }[];
    }>;
    create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession>;
    run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    private message;
    steer(id: string, input: string, messageId?: `${string}-${string}-${string}-${string}-${string}`): Promise<boolean>;
    private consumeSteering;
    abort(id: string): Promise<void>;
    private cancelNativeTurn;
    answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    getSessionWatchPath(_id: string): Promise<null>;
    listModels(): Promise<RuntimeModelInfo[]>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=copilot-client.d.ts.map