import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from "../../../domain/tool/entities.js";
import type { DispatchResult } from "./DispatchAgentTool.js";
export interface SpawnAgentInput {
    name: string;
    role: string;
    task: string;
    instructions?: string;
}
export declare class SpawnAgentTool implements ITool {
    private readonly spawnFn;
    readonly name = "spawn_agent";
    readonly description: string;
    readonly schema: z.ZodObject<{
        name: z.ZodString;
        role: z.ZodString;
        task: z.ZodString;
        instructions: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        role: string;
        task: string;
        instructions?: string | undefined;
    }, {
        name: string;
        role: string;
        task: string;
        instructions?: string | undefined;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            name: {
                type: string;
                description: string;
                maxLength: number;
            };
            role: {
                type: string;
                description: string;
                maxLength: number;
            };
            task: {
                type: string;
                description: string;
                maxLength: number;
            };
            instructions: {
                type: string;
                description: string;
                maxLength: number;
            };
        };
        required: string[];
    };
    constructor(spawnFn: (input: SpawnAgentInput, parentSessionId: string) => Promise<DispatchResult>);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=SpawnAgentTool.d.ts.map