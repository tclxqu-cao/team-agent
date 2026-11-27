import type { IToolExecutor, ToolContext, ToolResult } from "../../domain/tool/entities.js";
import type { ToolExecutionPolicy } from "../../domain/tool/execution-policy.js";
export declare class PolicyAwareToolExecutor implements IToolExecutor {
    private readonly delegate;
    private readonly policy;
    private readonly allowedTools;
    constructor(delegate: IToolExecutor, policy: ToolExecutionPolicy);
    validate(name: string, args: Record<string, unknown>): boolean;
    getAuthorizationPolicy(name: string): import("../../index.js").ToolAuthorizationPolicy;
    getNetworkAccess(name: string): import("../../index.js").ToolNetworkAccess;
    execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
    private networkDecision;
    private guardFilesystem;
    private executeBash;
}
export declare function resolvePolicyPath(requested: string, workingDirectory: string, roots: string[], accessMode: "read" | "write", followSymlinks: boolean): Promise<string>;
export declare function parseSimpleCommand(command: string): string[];
//# sourceMappingURL=policy-executor.d.ts.map