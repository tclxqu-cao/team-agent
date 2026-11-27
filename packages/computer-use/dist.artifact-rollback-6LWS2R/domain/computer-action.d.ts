import { z } from "zod";
export declare const computerActionSchema: z.ZodUnion<[z.ZodObject<{
    action: z.ZodLiteral<"observe">;
}, "strict", z.ZodTypeAny, {
    action: "observe";
}, {
    action: "observe";
}>, z.ZodObject<{
    action: z.ZodLiteral<"press">;
    revision: z.ZodString;
    nodeId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    action: "press";
    revision: string;
    nodeId: string;
}, {
    action: "press";
    revision: string;
    nodeId: string;
}>, z.ZodObject<{
    action: z.ZodEnum<["click", "double_click"]>;
    revision: z.ZodString;
    nodeId: z.ZodString;
    button: z.ZodOptional<z.ZodEnum<["left", "right", "middle"]>>;
}, "strict", z.ZodTypeAny, {
    action: "click" | "double_click";
    revision: string;
    nodeId: string;
    button?: "left" | "right" | "middle" | undefined;
}, {
    action: "click" | "double_click";
    revision: string;
    nodeId: string;
    button?: "left" | "right" | "middle" | undefined;
}>, z.ZodObject<{
    action: z.ZodEnum<["click", "double_click"]>;
    x: z.ZodNumber;
    y: z.ZodNumber;
    button: z.ZodOptional<z.ZodEnum<["left", "right", "middle"]>>;
}, "strict", z.ZodTypeAny, {
    action: "click" | "double_click";
    x: number;
    y: number;
    button?: "left" | "right" | "middle" | undefined;
}, {
    action: "click" | "double_click";
    x: number;
    y: number;
    button?: "left" | "right" | "middle" | undefined;
}>, z.ZodObject<{
    action: z.ZodLiteral<"type">;
    revision: z.ZodString;
    nodeId: z.ZodString;
    text: z.ZodString;
    replace: z.ZodOptional<z.ZodBoolean>;
}, "strict", z.ZodTypeAny, {
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
}>, z.ZodObject<{
    action: z.ZodLiteral<"keypress">;
    keys: z.ZodArray<z.ZodString, "many">;
}, "strict", z.ZodTypeAny, {
    action: "keypress";
    keys: string[];
}, {
    action: "keypress";
    keys: string[];
}>, z.ZodObject<{
    action: z.ZodLiteral<"scroll">;
    revision: z.ZodString;
    nodeId: z.ZodString;
    deltaX: z.ZodOptional<z.ZodNumber>;
    deltaY: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
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
}>, z.ZodObject<{
    action: z.ZodLiteral<"scroll">;
    x: z.ZodNumber;
    y: z.ZodNumber;
    deltaX: z.ZodOptional<z.ZodNumber>;
    deltaY: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
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
}>, z.ZodObject<{
    action: z.ZodLiteral<"move">;
    x: z.ZodNumber;
    y: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    action: "move";
    x: number;
    y: number;
}, {
    action: "move";
    x: number;
    y: number;
}>, z.ZodObject<{
    action: z.ZodLiteral<"drag">;
    startX: z.ZodNumber;
    startY: z.ZodNumber;
    endX: z.ZodNumber;
    endY: z.ZodNumber;
    durationMs: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
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
}>, z.ZodObject<{
    action: z.ZodLiteral<"wait">;
    durationMs: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    action: "wait";
    durationMs: number;
}, {
    action: "wait";
    durationMs: number;
}>, z.ZodObject<{
    action: z.ZodLiteral<"screenshot">;
}, "strict", z.ZodTypeAny, {
    action: "screenshot";
}, {
    action: "screenshot";
}>]>;
export type ComputerAction = z.infer<typeof computerActionSchema>;
export declare const MUTATING_COMPUTER_ACTIONS: Set<"type" | "observe" | "press" | "click" | "double_click" | "keypress" | "scroll" | "move" | "drag" | "wait" | "screenshot">;
export declare function isMutatingComputerAction(action: ComputerAction): boolean;
//# sourceMappingURL=computer-action.d.ts.map