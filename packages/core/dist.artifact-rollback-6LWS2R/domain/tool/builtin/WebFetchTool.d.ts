import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
export declare class WebFetchTool implements ITool {
    readonly name = "web_fetch";
    readonly networkAccess: "read";
    readonly description = "Fetch content from a URL and process into markdown";
    readonly schema: z.ZodObject<{
        url: z.ZodString;
        prompt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        url: string;
        prompt: string;
    }, {
        url: string;
        prompt: string;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            url: {
                type: string;
                description: string;
            };
            prompt: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
    private stripHtml;
}
//# sourceMappingURL=WebFetchTool.d.ts.map