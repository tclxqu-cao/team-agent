import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import type { CronTasks, CronTask } from '../../cron/index.js';
export type CronCreateFn = (cron: string, prompt: string, options?: {
    label?: string;
    recurring?: boolean;
    sessionId?: string;
}) => CronTask;
export declare class CronCreateTool implements ITool {
    private readonly onCreate;
    readonly name = "cron_create";
    readonly description: string;
    readonly schema: z.ZodObject<{
        cron: z.ZodString;
        prompt: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        recurring: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        cron: string;
        prompt: string;
        recurring: boolean;
        label?: string | undefined;
    }, {
        cron: string;
        prompt: string;
        label?: string | undefined;
        recurring?: boolean | undefined;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            cron: {
                type: string;
                description: string;
            };
            prompt: {
                type: string;
                description: string;
            };
            label: {
                type: string;
                description: string;
            };
            recurring: {
                type: string;
                description: string;
                default: boolean;
            };
        };
        required: string[];
    };
    constructor(onCreate: CronCreateFn);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
export declare class CronDeleteTool implements ITool {
    private readonly cronTasks;
    readonly name = "cron_delete";
    readonly description = "Delete a scheduled task by ID or ID prefix.";
    readonly schema: z.ZodObject<{
        id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
    }, {
        id: string;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            id: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    constructor(cronTasks: CronTasks);
    execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
}
export declare class CronListTool implements ITool {
    private readonly cronTasks;
    readonly name = "cron_list";
    readonly description = "List all scheduled tasks.";
    readonly schema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    readonly parameters: {
        type: string;
        properties: {};
    };
    constructor(cronTasks: CronTasks);
    execute(_params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=CronTools.d.ts.map