import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../../../domain/tool/entities.js';
export interface DispatchResult {
    status: "running" | "completed" | "failed";
    agentName: string;
    subSessionId: string;
    agentId?: string;
    summary?: string;
    code?: string;
    error?: string;
}
export declare class DispatchAgentTool implements ITool {
    private readonly dispatchFn;
    readonly name = "dispatch_agent";
    readonly description: string;
    readonly schema: z.ZodObject<{
        agentName: z.ZodString;
        task: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        agentName: string;
        task: string;
    }, {
        agentName: string;
        task: string;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            agentName: {
                type: string;
                description: string;
            };
            task: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    constructor(dispatchFn: (agentName: string, task: string, sessionId: string) => Promise<DispatchResult>);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=DispatchAgentTool.d.ts.map