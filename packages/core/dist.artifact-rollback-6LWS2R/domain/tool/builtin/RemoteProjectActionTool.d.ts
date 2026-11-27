import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from "../entities.js";
import type { RemoteToolStore } from "../../remote-tools/RemoteToolStore.js";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
interface Options {
    store?: RemoteToolStore;
    projectId?: string;
    fetchImpl?: FetchLike;
    actionToken?: string;
}
export declare function describeRemoteTool(tool: {
    scheme: string;
    purpose: string;
    inputSchema: Record<string, unknown>;
    examples: Array<Record<string, unknown>>;
}): string;
export declare class RemoteProjectActionTool implements ITool {
    readonly name = "remote_project_action";
    readonly networkAccess: "write";
    readonly schema: z.ZodObject<{
        action: z.ZodString;
        payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        action: string;
        payload: Record<string, unknown>;
    }, {
        action: string;
        payload: Record<string, unknown>;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            action: {
                type: string;
                description: string;
            };
            payload: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    private readonly store?;
    private readonly projectId;
    private readonly fetchImpl;
    private readonly actionToken?;
    constructor(options?: Options);
    get description(): string;
    execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
    private getJobStatus;
    private runJob;
    private markJobFailedSafely;
}
export {};
//# sourceMappingURL=RemoteProjectActionTool.d.ts.map