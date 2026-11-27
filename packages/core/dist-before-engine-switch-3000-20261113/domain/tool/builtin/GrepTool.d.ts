import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
export declare class GrepTool implements ITool {
    readonly name = "grep";
    readonly description = "Search for a keyword or regex pattern in files. Returns matching lines with file path and line number.";
    readonly schema: z.ZodObject<{
        pattern: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
        recursive: z.ZodOptional<z.ZodBoolean>;
        case_sensitive: z.ZodOptional<z.ZodBoolean>;
        include: z.ZodOptional<z.ZodString>;
        max_results: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        pattern: string;
        path?: string | undefined;
        recursive?: boolean | undefined;
        case_sensitive?: boolean | undefined;
        include?: string | undefined;
        max_results?: number | undefined;
    }, {
        pattern: string;
        path?: string | undefined;
        recursive?: boolean | undefined;
        case_sensitive?: boolean | undefined;
        include?: string | undefined;
        max_results?: number | undefined;
    }>;
    readonly parameters: Record<string, unknown>;
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
    private schemaToParams;
}
//# sourceMappingURL=GrepTool.d.ts.map