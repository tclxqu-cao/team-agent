import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
export declare class BashTool implements ITool {
    readonly name = "bash";
    readonly description = "Execute a bash command in the working directory";
    readonly schema: z.ZodObject<{
        command: z.ZodString;
        timeout: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        timeout: number;
        command: string;
    }, {
        command: string;
        timeout?: number | undefined;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            command: {
                type: string;
                description: string;
            };
            timeout: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=BashTool.d.ts.map