import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../../domain/tool/entities.js';
import type { ThreadGoalService } from './ThreadGoalService.js';
export declare class CreateGoalTool implements ITool {
    private readonly service;
    private readonly sessionId;
    readonly name = "create_goal";
    readonly description: string;
    readonly schema: z.ZodObject<{
        objective: z.ZodString;
        token_budget: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        objective: string;
        token_budget?: number | undefined;
    }, {
        objective: string;
        token_budget?: number | undefined;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            objective: {
                type: string;
                description: string;
            };
            token_budget: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    constructor(service: ThreadGoalService, sessionId: string);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
export declare class GetGoalTool implements ITool {
    private readonly service;
    private readonly sessionId;
    readonly name = "get_goal";
    readonly description = "\u67E5\u770B\u5F53\u524D\u4F1A\u8BDD\u7684\u76EE\u6807\u6A21\u5F0F\u72B6\u6001\uFF1A\u76EE\u6807\u6587\u672C\u3001\u72B6\u6001\uFF08active/paused/blocked/usage_limited/budget_limited/complete\uFF09\u3001token \u7528\u91CF\u4E0E\u9884\u7B97\u3001\u7EED\u8DD1\u8F6E\u6570\u3002";
    readonly schema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    readonly parameters: {
        type: string;
        properties: {};
        required: never[];
    };
    constructor(service: ThreadGoalService, sessionId: string);
    execute(_params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
export declare class UpdateGoalTool implements ITool {
    private readonly service;
    private readonly sessionId;
    readonly name = "update_goal";
    readonly description: string;
    readonly schema: z.ZodObject<{
        status: z.ZodEnum<["complete", "blocked", "paused"]>;
        reason: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "paused" | "blocked" | "complete";
        reason?: string | undefined;
    }, {
        status: "paused" | "blocked" | "complete";
        reason?: string | undefined;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            status: {
                type: string;
                enum: string[];
                description: string;
            };
            reason: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    constructor(service: ThreadGoalService, sessionId: string);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
export declare function createThreadGoalTools(service: ThreadGoalService, sessionId: string): ITool[];
//# sourceMappingURL=ThreadGoalTools.d.ts.map