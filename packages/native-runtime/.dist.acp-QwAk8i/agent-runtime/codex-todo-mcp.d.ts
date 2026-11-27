import type { NativeTodoMcpConfiguration } from "./runtime-tool-injection.js";
interface CodexTodoRpc {
    request<T>(method: string, params: unknown): Promise<T>;
}
/** A distinct name makes an ignored loaded-thread override detectable before sending. */
export declare function codexTodoMcpConfiguration(configuration: NativeTodoMcpConfiguration): {
    serverName: string;
    config: {
        [x: string]: {
            enabled: boolean;
            required: boolean;
            command: string;
            args: string[];
            env: {
                [k: string]: string;
            };
        };
    };
};
export declare function assertCodexTodoMcpReady(client: CodexTodoRpc, threadId: string, serverName: string, signal?: AbortSignal): Promise<void>;
export declare function resumeCodexThreadWithTodo(client: CodexTodoRpc, threadId: string, configuration: NativeTodoMcpConfiguration, signal?: AbortSignal): Promise<void>;
export {};
//# sourceMappingURL=codex-todo-mcp.d.ts.map