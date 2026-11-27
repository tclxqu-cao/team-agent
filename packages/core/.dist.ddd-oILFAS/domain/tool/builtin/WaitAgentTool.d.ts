import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import type { DispatchResult } from './DispatchAgentTool.js';
export declare class WaitAgentTool implements ITool {
    private readonly waitFn;
    readonly name = "wait_agent";
    readonly description: string;
    readonly schema: z.ZodObject<{
        subSessionId: z.ZodString;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        subSessionId: string;
        timeoutMs?: number | undefined;
    }, {
        subSessionId: string;
        timeoutMs?: number | undefined;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            subSessionId: {
                type: string;
                description: string;
            };
            timeoutMs: {
                type: string;
                description: string;
                optional: boolean;
            };
        };
        required: string[];
    };
    constructor(waitFn: (subSessionId: string, timeoutMs?: number) => Promise<DispatchResult>);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=WaitAgentTool.d.ts.map