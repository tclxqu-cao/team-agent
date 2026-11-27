import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../../../domain/tool/entities.js';
export declare class ShowWidgetTool implements ITool {
    readonly name = "show_widget";
    readonly description: string;
    readonly schema: z.ZodObject<{
        widget_type: z.ZodString;
        data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        update_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        data: Record<string, unknown>;
        widget_type: string;
        update_id?: string | undefined;
    }, {
        data: Record<string, unknown>;
        widget_type: string;
        update_id?: string | undefined;
    }>;
    readonly parameters: Record<string, unknown>;
    private schemaToParams;
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=ShowWidgetTool.d.ts.map