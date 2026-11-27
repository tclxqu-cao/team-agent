import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
export declare class GlobTool implements ITool {
    readonly name = "glob";
    readonly description: string;
    readonly schema: z.ZodObject<{
        pattern: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
        max_results: z.ZodOptional<z.ZodNumber>;
        include_hidden: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        pattern: string;
        path?: string | undefined;
        max_results?: number | undefined;
        include_hidden?: boolean | undefined;
    }, {
        pattern: string;
        path?: string | undefined;
        max_results?: number | undefined;
        include_hidden?: boolean | undefined;
    }>;
    readonly parameters: Record<string, unknown>;
    private schemaToParams;
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=GlobTool.d.ts.map