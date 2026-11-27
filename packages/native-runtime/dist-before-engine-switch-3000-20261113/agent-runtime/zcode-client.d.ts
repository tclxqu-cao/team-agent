import type { AgentEvent, Message } from "@agent/core";
import { type NativeRpcConnection } from "./native-rpc-client.js";
import { type ZCodeActivityReader } from "./zcode-desktop-activity.js";
import { type ZCodeDesktopGuide } from "./zcode-desktop-bridge.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { type CreateRuntimeSessionOptions, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";
export declare function decodeZCodeHistory(value: unknown, sessionId?: string, imageData?: ReadonlyMap<string, string>): Message[];
/** ZCode's strict NDJSON RPC deliberately has no JSON-RPC version field. */
export declare class ZCodeClient implements NativeSessionProtocol {
    private readonly rpc;
    private readonly activity;
    private readonly desktopGuide;
    private readonly imageStorageRoot;
    private readonly sessions;
    private readonly loaded;
    private readonly resumes;
    private readonly runs;
    private readonly questions;
    private readonly interactions;
    private models;
    private readonly modelDefaults;
    private readonly childCatalog;
    private readonly unsubscribe;
    private readonly steering;
    constructor(rpc?: NativeRpcConnection, activity?: ZCodeActivityReader, desktopGuide?: ZCodeDesktopGuide, imageStorageRoot?: string);
    available(): Promise<void>;
    private session;
    private snapshot;
    list(): Promise<NativeProtocolSession[]>;
    private withDesktopActivity;
    private resume;
    /** Idle eviction can report either inactive or runtime-not-ready. Never retry a send. */
    private withActiveSession;
    read(id: string): Promise<{
        session: NativeProtocolSession;
        messages: Message[];
    }>;
    create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession>;
    restoreDraft(session: NativeProtocolSession): void;
    listModels(): Promise<RuntimeModelInfo[]>;
    run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    private finish;
    private notification;
    private callback;
    private resolveQuestion;
    private cancelQuestions;
    answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    abort(id: string): Promise<void>;
    steer(id: string, input: string, messageId?: string): Promise<boolean>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=zcode-client.d.ts.map