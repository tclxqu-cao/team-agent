import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../../../domain/tool/entities.js';
export declare class StrReplaceTool implements ITool {
    readonly name = "str_replace";
    readonly description = "Replace an exact string in a file with new content.\nUse this instead of write_file when making targeted edits to existing files.\nThe old_string must match the file content EXACTLY (including whitespace and indentation).\nInclude 2-3 lines of context before and after to uniquely identify the target location.\nIf old_string appears multiple times, use more context to make it unique.";
    readonly schema: z.ZodObject<{
        file_path: z.ZodString;
        old_string: z.ZodString;
        new_string: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        file_path: string;
        old_string: string;
        new_string: string;
    }, {
        file_path: string;
        old_string: string;
        new_string: string;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            file_path: {
                type: string;
                description: string;
            };
            old_string: {
                type: string;
                description: string;
            };
            new_string: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=StrReplaceTool.d.ts.map