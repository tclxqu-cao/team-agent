import type { AgentEvent } from "@agent/core";
import { type NativeStdioCommand } from "./native-stdio-channel.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { WorkBuddySessionCatalog } from "./workbuddy-session-catalog.js";
import { type CreateRuntimeSessionOptions, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";
interface Options {
    catalog?: Pick<WorkBuddySessionCatalog, "list" | "read">;
    command?: () => Promise<NativeStdioCommand>;
}
/** WorkBuddy stream-json is not ACP: response correlation is nested under response. */
export declare class WorkBuddyClient implements NativeSessionProtocol {
    private readonly catalog;
    private readonly command;
    private readonly drafts;
    private readonly runs;
    private readonly permissions;
    constructor(options?: Options);
    private channel;
    private control;
    available(): Promise<void>;
    private metadata;
    listModels(): Promise<RuntimeModelInfo[]>;
    list(): Promise<NativeProtocolSession[]>;
    read(id: string): Promise<{
        session: NativeProtocolSession;
        messages: import("@agent/core").Message[];
    }>;
    create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession>;
    restoreDraft(session: NativeProtocolSession): void;
    run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    private finish;
    private tool;
    private packet;
    answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    abort(id: string): Promise<void>;
    dispose(): Promise<void>;
}
export {};
//# sourceMappingURL=workbuddy-client.d.ts.map