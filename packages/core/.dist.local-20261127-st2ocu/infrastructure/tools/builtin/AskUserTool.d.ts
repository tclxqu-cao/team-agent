import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../../../domain/tool/entities.js';
export interface AskUserField {
    name: string;
    label: string;
    description?: string;
    type?: "text" | "secret";
}
export interface AskUserRequest {
    question: string;
    options?: Array<{
        label: string;
        description: string;
    }>;
    fields?: AskUserField[];
    multiSelect?: boolean;
    toolCallId: string;
}
export interface AskUserResponse {
    /** The selected option label(s), or the free-text answer */
    answer: string;
    /** Indices of selected options (for multiSelect) */
    selectedIndices?: number[];
}
/**
 * Callback type: emits the question to the UI, then blocks until the user responds.
 * Implemented by the desktop host via IPC events.
 */
export type AskUserCallback = (request: AskUserRequest) => Promise<AskUserResponse>;
export declare class AskUserTool implements ITool {
    private readonly askFn;
    readonly name = "ask_user";
    readonly description: string;
    readonly schema: z.ZodObject<{
        question: z.ZodString;
        options: z.ZodOptional<z.ZodArray<z.ZodObject<{
            label: z.ZodString;
            description: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            description: string;
            label: string;
        }, {
            description: string;
            label: string;
        }>, "many">>;
        fields: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            label: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            type: z.ZodOptional<z.ZodEnum<["text", "secret"]>>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            label: string;
            description?: string | undefined;
            type?: "text" | "secret" | undefined;
        }, {
            name: string;
            label: string;
            description?: string | undefined;
            type?: "text" | "secret" | undefined;
        }>, "many">>;
        multiSelect: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        question: string;
        options?: {
            description: string;
            label: string;
        }[] | undefined;
        fields?: {
            name: string;
            label: string;
            description?: string | undefined;
            type?: "text" | "secret" | undefined;
        }[] | undefined;
        multiSelect?: boolean | undefined;
    }, {
        question: string;
        options?: {
            description: string;
            label: string;
        }[] | undefined;
        fields?: {
            name: string;
            label: string;
            description?: string | undefined;
            type?: "text" | "secret" | undefined;
        }[] | undefined;
        multiSelect?: boolean | undefined;
    }>;
    readonly parameters: {
        type: string;
        properties: {
            question: {
                type: string;
                description: string;
            };
            options: {
                type: string;
                description: string;
                items: {
                    type: string;
                    properties: {
                        label: {
                            type: string;
                            description: string;
                        };
                        description: {
                            type: string;
                            description: string;
                        };
                    };
                    required: string[];
                };
            };
            fields: {
                type: string;
                description: string;
                items: {
                    type: string;
                    properties: {
                        name: {
                            type: string;
                            description: string;
                        };
                        label: {
                            type: string;
                            description: string;
                        };
                        description: {
                            type: string;
                            description: string;
                        };
                        type: {
                            type: string;
                            enum: string[];
                            description: string;
                        };
                    };
                    required: string[];
                };
            };
            multiSelect: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
    constructor(askFn: AskUserCallback);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=AskUserTool.d.ts.map