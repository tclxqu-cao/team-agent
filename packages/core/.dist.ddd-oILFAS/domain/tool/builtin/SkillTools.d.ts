import { z } from "zod";
import type { SkillRegistry } from "../../skill/SkillRegistry.js";
import type { ITool, ToolContext, ToolResult } from "../entities.js";
export declare class SkillDiscoverTool implements ITool {
    private readonly registry;
    private readonly enabledSkills;
    readonly name = "skill_discover";
    readonly description: string;
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
    constructor(registry: SkillRegistry, enabledSkills: string[] | null);
    execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
    private error;
}
export declare class SkillLoadTool implements ITool {
    private readonly registry;
    private readonly enabledSkills;
    readonly name = "skill_load";
    readonly description: string;
    readonly schema: z.ZodObject<{
        name: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        name: string;
    }, {
        name: string;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            name: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    constructor(registry: SkillRegistry, enabledSkills: string[] | null);
    execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
    private error;
}
//# sourceMappingURL=SkillTools.d.ts.map