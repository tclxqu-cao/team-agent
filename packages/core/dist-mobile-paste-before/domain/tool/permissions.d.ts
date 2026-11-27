import type { IToolExecutor, ToolContext, ToolResult } from "./entities.js";
export declare const TOOL_PERMISSION_MODES: readonly ["request-approval", "auto-approval", "full-access"];
export type ToolPermissionMode = (typeof TOOL_PERMISSION_MODES)[number];
export type ToolApprovalDecision = "allow-once" | "allow-session" | "deny" | "cancel";
export declare const TOOL_APPROVAL_OPTIONS: readonly [{
    readonly label: "允许一次";
    readonly description: "仅允许当前这次工具调用";
}, {
    readonly label: "本会话允许";
    readonly description: "当前会话再次执行相同工具和目标时不再询问";
}, {
    readonly label: "拒绝";
    readonly description: "不执行这次工具调用，让 Agent 继续处理";
}, {
    readonly label: "取消本轮";
    readonly description: "不执行工具，并立即停止当前回复";
}];
export interface ToolPermissionRequest {
    sessionId: string;
    toolName: string;
    summary: string;
    reason: string;
    resourceKey: string;
    args: Record<string, unknown>;
}
export interface ToolPermissionGateOptions {
    resolveMode(sessionId: string): ToolPermissionMode | Promise<ToolPermissionMode>;
    requestApproval(request: ToolPermissionRequest): Promise<ToolApprovalDecision>;
}
export interface ToolPermissionClassification {
    kind: "safe" | "workspace-write" | "external-write" | "shell" | "network" | "remote" | "risky-local" | "unknown";
    risky: boolean;
    summary: string;
    reason: string;
    resourceKey: string;
}
export declare function normalizeToolPermissionMode(value: unknown): ToolPermissionMode;
export declare function isToolPermissionMode(value: unknown): value is ToolPermissionMode;
export declare function toolApprovalDecisionFromAnswer(answer: string, selectedIndices?: number[]): ToolApprovalDecision;
export declare function writePaths(toolName: string, args: Record<string, unknown>): string[];
export declare function classifyToolPermission(toolName: string, args: Record<string, unknown>, workingDirectory: string): ToolPermissionClassification;
export declare class ToolPermissionGate {
    private readonly options;
    private readonly sessionApprovals;
    private readonly approvalQueues;
    constructor(options: ToolPermissionGateOptions);
    clearSession(sessionId: string): void;
    authorize(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<"allow" | "deny" | "cancel">;
    private enqueue;
}
export declare class PermissionAwareToolExecutor implements IToolExecutor {
    private readonly delegate;
    private readonly gate;
    constructor(delegate: IToolExecutor, gate: ToolPermissionGate);
    validate(name: string, args: Record<string, unknown>): boolean;
    getAuthorizationPolicy(name: string): import("./entities.js").ToolAuthorizationPolicy;
    getNetworkAccess(name: string): import("./entities.js").ToolNetworkAccess;
    execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
//# sourceMappingURL=permissions.d.ts.map