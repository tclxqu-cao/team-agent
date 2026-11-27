import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { TodoServiceClient } from "./todo-service-client";
export declare function createTodoMcpServer(client: Pick<TodoServiceClient, "call">, scope: string): Server<{
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
    } | undefined;
}, {
    method: string;
    params?: {
        [x: string]: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
    } | undefined;
}, {
    [x: string]: unknown;
    _meta?: {
        [x: string]: unknown;
        progressToken?: string | number | undefined;
        "io.modelcontextprotocol/related-task"?: {
            taskId: string;
        } | undefined;
    } | undefined;
}>;
export declare function runTodoMcpStdio(options: {
    serviceId: string;
    descriptorPath?: string;
    deferServiceCheck?: boolean;
}): Promise<void>;
//# sourceMappingURL=stdio.d.ts.map