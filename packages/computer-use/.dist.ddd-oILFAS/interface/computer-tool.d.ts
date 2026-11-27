import type { ITool, ToolContext, ToolResult } from "@agent/core";
import type { ComputerRuntimePort } from "../ports/computer-runtime-port.js";
export declare const COMPUTER_TOOL_PARAMETERS: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["action"];
    readonly properties: {
        readonly action: {
            readonly type: "string";
            readonly enum: readonly ["observe", "press", "click", "double_click", "type", "keypress", "scroll", "move", "drag", "wait", "screenshot"];
        };
        readonly revision: {
            readonly type: "string";
            readonly description: "Revision from the latest Accessibility observation.";
        };
        readonly nodeId: {
            readonly type: "string";
            readonly description: "Node ID from the same revision.";
        };
        readonly x: {
            readonly type: "number";
            readonly minimum: 0;
            readonly description: "X coordinate in the latest screenshot pixels.";
        };
        readonly y: {
            readonly type: "number";
            readonly minimum: 0;
            readonly description: "Y coordinate in the latest screenshot pixels.";
        };
        readonly button: {
            readonly type: "string";
            readonly enum: readonly ["left", "right", "middle"];
        };
        readonly text: {
            readonly type: "string";
            readonly maxLength: 10000;
        };
        readonly replace: {
            readonly type: "boolean";
        };
        readonly keys: {
            readonly type: "array";
            readonly minItems: 1;
            readonly maxItems: 16;
            readonly items: {
                readonly type: "string";
            };
        };
        readonly deltaX: {
            readonly type: "number";
        };
        readonly deltaY: {
            readonly type: "number";
        };
        readonly startX: {
            readonly type: "number";
            readonly minimum: 0;
        };
        readonly startY: {
            readonly type: "number";
            readonly minimum: 0;
        };
        readonly endX: {
            readonly type: "number";
            readonly minimum: 0;
        };
        readonly endY: {
            readonly type: "number";
            readonly minimum: 0;
        };
        readonly durationMs: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly maximum: 5000;
        };
    };
    readonly allOf: readonly [{
        readonly if: {
            readonly properties: {
                readonly action: {
                    readonly const: "press";
                };
            };
        };
        readonly then: {
            readonly required: readonly ["revision", "nodeId"];
        };
    }, {
        readonly if: {
            readonly properties: {
                readonly action: {
                    readonly const: "type";
                };
            };
        };
        readonly then: {
            readonly required: readonly ["revision", "nodeId", "text"];
        };
    }, {
        readonly if: {
            readonly properties: {
                readonly action: {
                    readonly const: "keypress";
                };
            };
        };
        readonly then: {
            readonly required: readonly ["keys"];
        };
    }, {
        readonly if: {
            readonly properties: {
                readonly action: {
                    readonly const: "drag";
                };
            };
        };
        readonly then: {
            readonly required: readonly ["startX", "startY", "endX", "endY"];
        };
    }, {
        readonly if: {
            readonly properties: {
                readonly action: {
                    readonly const: "wait";
                };
            };
        };
        readonly then: {
            readonly required: readonly ["durationMs"];
        };
    }];
};
export declare class ComputerTool implements ITool {
    readonly name = "computer";
    readonly authorization: "direct";
    readonly schema: import("zod").ZodUnion<[import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"observe">;
    }, "strict", import("zod").ZodTypeAny, {
        action: "observe";
    }, {
        action: "observe";
    }>, import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"press">;
        revision: import("zod").ZodString;
        nodeId: import("zod").ZodString;
    }, "strict", import("zod").ZodTypeAny, {
        action: "press";
        revision: string;
        nodeId: string;
    }, {
        action: "press";
        revision: string;
        nodeId: string;
    }>, import("zod").ZodObject<{
        action: import("zod").ZodEnum<["click", "double_click"]>;
        revision: import("zod").ZodString;
        nodeId: import("zod").ZodString;
        button: import("zod").ZodOptional<import("zod").ZodEnum<["left", "right", "middle"]>>;
    }, "strict", import("zod").ZodTypeAny, {
        action: "click" | "double_click";
        revision: string;
        nodeId: string;
        button?: "left" | "right" | "middle" | undefined;
    }, {
        action: "click" | "double_click";
        revision: string;
        nodeId: string;
        button?: "left" | "right" | "middle" | undefined;
    }>, import("zod").ZodObject<{
        action: import("zod").ZodEnum<["click", "double_click"]>;
        x: import("zod").ZodNumber;
        y: import("zod").ZodNumber;
        button: import("zod").ZodOptional<import("zod").ZodEnum<["left", "right", "middle"]>>;
    }, "strict", import("zod").ZodTypeAny, {
        action: "click" | "double_click";
        x: number;
        y: number;
        button?: "left" | "right" | "middle" | undefined;
    }, {
        action: "click" | "double_click";
        x: number;
        y: number;
        button?: "left" | "right" | "middle" | undefined;
    }>, import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"type">;
        revision: import("zod").ZodString;
        nodeId: import("zod").ZodString;
        text: import("zod").ZodString;
        replace: import("zod").ZodOptional<import("zod").ZodBoolean>;
    }, "strict", import("zod").ZodTypeAny, {
        action: "type";
        revision: string;
        nodeId: string;
        text: string;
        replace?: boolean | undefined;
    }, {
        action: "type";
        revision: string;
        nodeId: string;
        text: string;
        replace?: boolean | undefined;
    }>, import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"keypress">;
        keys: import("zod").ZodArray<import("zod").ZodString, "many">;
    }, "strict", import("zod").ZodTypeAny, {
        action: "keypress";
        keys: string[];
    }, {
        action: "keypress";
        keys: string[];
    }>, import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"scroll">;
        revision: import("zod").ZodString;
        nodeId: import("zod").ZodString;
        deltaX: import("zod").ZodOptional<import("zod").ZodNumber>;
        deltaY: import("zod").ZodNumber;
    }, "strict", import("zod").ZodTypeAny, {
        action: "scroll";
        revision: string;
        nodeId: string;
        deltaY: number;
        deltaX?: number | undefined;
    }, {
        action: "scroll";
        revision: string;
        nodeId: string;
        deltaY: number;
        deltaX?: number | undefined;
    }>, import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"scroll">;
        x: import("zod").ZodNumber;
        y: import("zod").ZodNumber;
        deltaX: import("zod").ZodOptional<import("zod").ZodNumber>;
        deltaY: import("zod").ZodNumber;
    }, "strict", import("zod").ZodTypeAny, {
        action: "scroll";
        x: number;
        y: number;
        deltaY: number;
        deltaX?: number | undefined;
    }, {
        action: "scroll";
        x: number;
        y: number;
        deltaY: number;
        deltaX?: number | undefined;
    }>, import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"move">;
        x: import("zod").ZodNumber;
        y: import("zod").ZodNumber;
    }, "strict", import("zod").ZodTypeAny, {
        action: "move";
        x: number;
        y: number;
    }, {
        action: "move";
        x: number;
        y: number;
    }>, import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"drag">;
        startX: import("zod").ZodNumber;
        startY: import("zod").ZodNumber;
        endX: import("zod").ZodNumber;
        endY: import("zod").ZodNumber;
        durationMs: import("zod").ZodOptional<import("zod").ZodNumber>;
    }, "strict", import("zod").ZodTypeAny, {
        action: "drag";
        startX: number;
        startY: number;
        endX: number;
        endY: number;
        durationMs?: number | undefined;
    }, {
        action: "drag";
        startX: number;
        startY: number;
        endX: number;
        endY: number;
        durationMs?: number | undefined;
    }>, import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"wait">;
        durationMs: import("zod").ZodNumber;
    }, "strict", import("zod").ZodTypeAny, {
        action: "wait";
        durationMs: number;
    }, {
        action: "wait";
        durationMs: number;
    }>, import("zod").ZodObject<{
        action: import("zod").ZodLiteral<"screenshot">;
    }, "strict", import("zod").ZodTypeAny, {
        action: "screenshot";
    }, {
        action: "screenshot";
    }>]>;
    readonly parameters: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["action"];
        readonly properties: {
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["observe", "press", "click", "double_click", "type", "keypress", "scroll", "move", "drag", "wait", "screenshot"];
            };
            readonly revision: {
                readonly type: "string";
                readonly description: "Revision from the latest Accessibility observation.";
            };
            readonly nodeId: {
                readonly type: "string";
                readonly description: "Node ID from the same revision.";
            };
            readonly x: {
                readonly type: "number";
                readonly minimum: 0;
                readonly description: "X coordinate in the latest screenshot pixels.";
            };
            readonly y: {
                readonly type: "number";
                readonly minimum: 0;
                readonly description: "Y coordinate in the latest screenshot pixels.";
            };
            readonly button: {
                readonly type: "string";
                readonly enum: readonly ["left", "right", "middle"];
            };
            readonly text: {
                readonly type: "string";
                readonly maxLength: 10000;
            };
            readonly replace: {
                readonly type: "boolean";
            };
            readonly keys: {
                readonly type: "array";
                readonly minItems: 1;
                readonly maxItems: 16;
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly deltaX: {
                readonly type: "number";
            };
            readonly deltaY: {
                readonly type: "number";
            };
            readonly startX: {
                readonly type: "number";
                readonly minimum: 0;
            };
            readonly startY: {
                readonly type: "number";
                readonly minimum: 0;
            };
            readonly endX: {
                readonly type: "number";
                readonly minimum: 0;
            };
            readonly endY: {
                readonly type: "number";
                readonly minimum: 0;
            };
            readonly durationMs: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 5000;
            };
        };
        readonly allOf: readonly [{
            readonly if: {
                readonly properties: {
                    readonly action: {
                        readonly const: "press";
                    };
                };
            };
            readonly then: {
                readonly required: readonly ["revision", "nodeId"];
            };
        }, {
            readonly if: {
                readonly properties: {
                    readonly action: {
                        readonly const: "type";
                    };
                };
            };
            readonly then: {
                readonly required: readonly ["revision", "nodeId", "text"];
            };
        }, {
            readonly if: {
                readonly properties: {
                    readonly action: {
                        readonly const: "keypress";
                    };
                };
            };
            readonly then: {
                readonly required: readonly ["keys"];
            };
        }, {
            readonly if: {
                readonly properties: {
                    readonly action: {
                        readonly const: "drag";
                    };
                };
            };
            readonly then: {
                readonly required: readonly ["startX", "startY", "endX", "endY"];
            };
        }, {
            readonly if: {
                readonly properties: {
                    readonly action: {
                        readonly const: "wait";
                    };
                };
            };
            readonly then: {
                readonly required: readonly ["durationMs"];
            };
        }];
    };
    readonly description: string;
    private readonly executeAction;
    constructor(runtime: ComputerRuntimePort);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=computer-tool.d.ts.map