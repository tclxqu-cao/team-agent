import { type GlobalEvent, type OpencodeClient } from "@opencode-ai/sdk";
import type { EventPermissionAsked, EventPermissionReplied } from "@opencode-ai/sdk/v2/types";
import { type OpenCodeRuntimeClient } from "./opencode-v2-transport.js";
import { OPENCODE_INTERRUPTED_EVENT } from "./opencode-v2-codec.js";
import { type OpenCodeQuestionEvent } from "./opencode-questions.js";
export interface OpenCodeServerEvent {
    directory: string;
    payload: GlobalEvent["payload"] | EventPermissionAsked | EventPermissionReplied | OpenCodeQuestionEvent | {
        type: typeof OPENCODE_INTERRUPTED_EVENT;
        properties: {
            sessionID: string;
        };
    };
}
type EventListener = (event: OpenCodeServerEvent) => void;
type FailureListener = (error: Error) => void;
export declare class OpenCodeServerClient {
    private readonly executable;
    private readonly unavailableError?;
    private readonly environment;
    private startPromise;
    private process;
    private stopEventStream;
    private readonly listeners;
    private readonly failureListeners;
    private disposed;
    constructor(options?: {
        executable?: string;
        unavailableError?: string;
        environment?: NodeJS.ProcessEnv;
    });
    client(): Promise<OpenCodeRuntimeClient>;
    subscribe(listener: EventListener, onFailure?: FailureListener): () => void;
    dispose(): Promise<void>;
    private start;
    private startEventStream;
    private notifyFailure;
}
interface OpenCodeEventSubscriptionOptions {
    onEvent: (event: GlobalEvent) => void;
    onEventError: (error: Error) => void;
    onFailure: (error: Error) => void;
    reconnectDelayMs?: (attempt: number) => number;
}
export declare function subscribeToOpenCodeEvents(client: OpencodeClient, options: OpenCodeEventSubscriptionOptions): () => void;
export {};
//# sourceMappingURL=opencode-server-client.d.ts.map