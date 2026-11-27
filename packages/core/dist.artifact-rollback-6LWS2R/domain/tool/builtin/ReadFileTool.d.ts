import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
export declare class ReadFileTool implements ITool {
    readonly name = "read_file";
    readonly description = "Read the contents of a file at the given path";
    readonly schema: z.ZodObject<{
        file_path: z.ZodString;
        offset: z.ZodOptional<z.ZodNumber>;
        limit: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        file_path: string;
        offset?: number | undefined;
        limit?: number | undefined;
    }, {
        file_path: string;
        offset?: number | undefined;
        limit?: number | undefined;
    }>;
    readonly parameters: Record<string, unknown>;
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
    private schemaToParams;
}
//# sourceMappingURL=ReadFileTool.d.ts.map