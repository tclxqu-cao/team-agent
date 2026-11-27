import type { AgentEvent, Message, ToolPermissionMode } from "@agent/core";
import { type NativeRpcConnection } from "./native-rpc-client.js";
import { type ZCodeActivityReader } from "./zcode-desktop-activity.js";
import { type ZCodeQuestionHistoryOptions } from "./zcode-questions.js";
import { type ZCodeDesktopGuide } from "./zcode-desktop-bridge.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { type CreateRuntimeSessionOptions, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";
/** ZCode native modes accepted by session/setMode; build asks before changes, edit auto-applies edits, yolo runs fully automatic. */
export declare function zcodeModeForPermission(permissionMode: ToolPermissionMode): "build" | "edit" | "yolo";
export type ZCodeHistoryDecodeOptions = ZCodeQuestionHistoryOptions;
export declare function decodeZCodeHistory(value: unknown, sessionId?: string, imageData?: ReadonlyMap<string, string>, options?: ZCodeHistoryDecodeOptions): Message[];
/** ZCode's strict NDJSON RPC deliberately has no JSON-RPC version field. */
export declare class ZCodeClient implements NativeSessionProtocol {
    private readonly rpc;
    private readonly activity;
    private readonly desktopGuide;
    private readonly imageStorageRoot;
    private readonly sessions;
    private readonly loaded;
    private readonly todoMcp;
    private readonly resumes;
    private readonly historyReads;
    private readonly historyCache;
    private readonly runs;
    private readonly pendingTodoRuns;
    private readonly questions;
    private readonly pendingQuestions;
    private readonly pendingQuestionReads;
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
    private configureTodoMcp;
    /** Idle eviction can report either inactive or runtime-not-ready. Never retry a send. */
    private withActiveSession;
    read(id: string): Promise<{
        session: NativeProtocolSession;
        messages: Message[];
    }>;
    private historyBatches;
    private readHistory;
    private decodeSessionHistory;
    private readPendingQuestionState;
    private rememberPendingQuestions;
    private clearPendingInteraction;
    create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession>;
    restoreDraft(session: NativeProtocolSession): void;
    listModels(): Promise<RuntimeModelInfo[]>;
    private modelEffort;
    run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    private runPrepared;
    /** A turn must not start unless the requested native permission mode was applied. */
    private applySessionMode;
    private finish;
    private notification;
    private callback;
    private resolveQuestion;
    private cancelQuestions;
    answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    private resolvePendingQuestion;
    abort(id: string): Promise<void>;
    steer(id: string, input: string, messageId?: string): Promise<boolean>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=zcode-client.d.ts.map