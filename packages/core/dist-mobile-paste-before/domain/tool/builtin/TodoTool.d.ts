import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import type { TodoItem } from '../../agent/entities.js';
export declare class TodoAddTool implements ITool {
    private readonly getTodos;
    private readonly setTodos;
    readonly name = "todo_add";
    readonly description: string;
    readonly schema: z.ZodObject<{
        todos: z.ZodArray<z.ZodObject<{
            title: z.ZodString;
            agentName: z.ZodOptional<z.ZodString>;
            dependsOn: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            title: string;
            agentName?: string | undefined;
            dependsOn?: string[] | undefined;
        }, {
            title: string;
            agentName?: string | undefined;
            dependsOn?: string[] | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        todos: {
            title: string;
            agentName?: string | undefined;
            dependsOn?: string[] | undefined;
        }[];
    }, {
        todos: {
            title: string;
            agentName?: string | undefined;
            dependsOn?: string[] | undefined;
        }[];
    }>;
    readonly parameters: {
        type: string;
        properties: {
            todos: {
                type: string;
                items: {
                    type: string;
                    properties: {
                        title: {
                            type: string;
                            description: string;
                        };
                        agentName: {
                            type: string;
                            description: string;
                        };
                        dependsOn: {
                            type: string;
                            items: {
                                type: string;
                            };
                            description: string;
                        };
                    };
                    required: string[];
                };
                description: string;
            };
        };
        required: string[];
    };
    constructor(getTodos: () => TodoItem[], setTodos: (todos: TodoItem[]) => void);
    execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
}
export declare class TodoUpdateTool implements ITool {
    private readonly getTodos;
    private readonly setTodos;
    readonly name = "todo_update";
    readonly description: string;
    readonly schema: z.ZodEffects<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<["pending", "in-progress", "completed"]>;
    }, "strip", z.ZodTypeAny, {
        status: "completed" | "pending" | "in-progress";
        id?: string | undefined;
        title?: string | undefined;
    }, {
        status: "completed" | "pending" | "in-progress";
        id?: string | undefined;
        title?: string | undefined;
    }>, {
        status: "completed" | "pending" | "in-progress";
        id?: string | undefined;
        title?: string | undefined;
    }, {
        status: "completed" | "pending" | "in-progress";
        id?: string | undefined;
        title?: string | undefined;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            id: {
                type: string;
                description: string;
            };
            title: {
                type: string;
                description: string;
            };
            status: {
                type: string;
                enum: string[];
                description: string;
            };
        };
        required: string[];
    };
    constructor(getTodos: () => TodoItem[], setTodos: (todos: TodoItem[]) => void);
    execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
}
export declare class TodoListTool implements ITool {
    private readonly getTodos;
    readonly name = "todo_list";
    readonly description: string;
    readonly schema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    readonly parameters: {
        type: string;
        properties: {};
        required: never[];
    };
    constructor(getTodos: () => TodoItem[]);
    execute(_params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=TodoTool.d.ts.map