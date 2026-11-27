import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../../../domain/tool/entities.js';
export declare class WriteFileTool implements ITool {
    readonly name = "write_file";
    readonly description = "Write content to a file at the given path";
    readonly schema: z.ZodObject<{
        file_path: z.ZodString;
        content: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        content: string;
        file_path: string;
    }, {
        content: string;
        file_path: string;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            file_path: {
                type: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=WriteFileTool.d.ts.map