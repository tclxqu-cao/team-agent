import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../../../domain/tool/entities.js';
export declare class WebSearchTool implements ITool {
    readonly name = "web_search";
    readonly networkAccess: "read";
    readonly description = "Search the web for information using DuckDuckGo HTML, falling back to Bing";
    readonly schema: z.ZodObject<{
        query: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        query: string;
    }, {
        query: string;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
    private searchDuckDuckGo;
    private searchBing;
    private parseDuckDuckGoResults;
    private parseBingResults;
}
//# sourceMappingURL=WebSearchTool.d.ts.map