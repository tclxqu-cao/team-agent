import type { NativeTodoMcpConfiguration } from "../agent-runtime/runtime-tool-injection";
import { TodoServiceClient, type TodoClientOptions } from "./todo-service-client";
type TodoCaller = Pick<TodoServiceClient, "call">;
type ClientFactory = (options: TodoClientOptions) => TodoCaller;
/** A one-shot bridge over the same scoped service client as the Todo MCP server.
 * Credentials stay in their descriptor file, never in command text or prompts. */
export declare function runTodoCommandBridge(encodedOptions: string, encodedRequest: string, clientFactory?: ClientFactory): Promise<unknown>;
export interface TodoCommandLaunch {
    executable: string;
    args: string[];
    env: Record<string, string>;
    /** The request argument uses only the base64url alphabet. */
    requestPlaceholder: string;
    command: string;
}
interface TodoCommandRuntime {
    executable: string;
    moduleUrl: string;
    platform: NodeJS.Platform;
    env?: {
        ELECTRON_RUN_AS_NODE?: string;
    };
}
/** Quote each argv item for the native shell; JSON is encoded data, never shell. */
export declare function todoCommandLaunch(options: TodoClientOptions, runtime: TodoCommandRuntime): TodoCommandLaunch;
export interface TodoPromptBridge {
    wrap(input: string): string;
}
/** Host sessions have no supported MCP mount operation. This uses their existing
 * terminal tool and preserves the Host's session and writer ownership. */
export declare function prepareTodoCommandBridge(configuration: NativeTodoMcpConfiguration, dependencies?: {
    clientFactory?: ClientFactory;
    runtime?: TodoCommandRuntime;
}): Promise<TodoPromptBridge>;
/** Strip only the exact complete internal envelope; malformed/user text survives. */
export declare function stripTodoCommandBridgeInstructions(input: string): string;
export {};
//# sourceMappingURL=command-bridge.d.ts.map