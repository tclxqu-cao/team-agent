export type ToolPolicyCommandMode = "deny" | "allowlist" | "unrestricted";
export type ToolPolicyNetworkMode = "deny" | "read-only" | "allow";
export interface ToolPolicyProgramRule {
    executable: string;
    subcommands?: string[];
    allowedFlags?: string[];
    deniedFlags?: string[];
    pathFlags?: string[];
    positionalPathIndexes?: number[];
}
export interface ToolExecutionPolicy {
    id: string;
    name: string;
    enabled: boolean;
    allowedTools: string[];
    filesystem: {
        readRoots: string[];
        writeRoots: string[];
        followSymlinks: boolean;
    };
    commands: {
        mode: ToolPolicyCommandMode;
        programs: ToolPolicyProgramRule[];
        inheritedEnvironment: string[];
    };
    network: ToolPolicyNetworkMode;
    limits: {
        timeoutMs: number;
        maxOutputBytes: number;
    };
}
export interface StoredToolExecutionPolicy extends ToolExecutionPolicy {
    created: string;
    updated: string;
}
export interface ToolExecutionPolicySummary {
    id: string;
    name: string;
}
export interface ToolExecutionPolicyStore {
    list(): Promise<StoredToolExecutionPolicy[]>;
    get(id: string): Promise<StoredToolExecutionPolicy | null>;
    save(policy: ToolExecutionPolicy): Promise<StoredToolExecutionPolicy>;
    delete(id: string): Promise<boolean>;
}
export type ToolExecutionPolicyErrorCode = "TOOL_POLICY_NOT_FOUND" | "TOOL_POLICY_DISABLED" | "TOOL_POLICY_DENIED" | "INVALID_TOOL_POLICY";
export declare class ToolExecutionPolicyError extends Error {
    readonly code: ToolExecutionPolicyErrorCode;
    constructor(code: ToolExecutionPolicyErrorCode, message: string);
}
export interface ToolExecutionPolicyValidationOptions {
    knownTools?: Iterable<string>;
    requireExecutables?: boolean;
}
export declare function validateToolExecutionPolicy(value: unknown, options?: ToolExecutionPolicyValidationOptions): ToolExecutionPolicy;
export declare function toolExecutionPolicySummary(policy: ToolExecutionPolicy): ToolExecutionPolicySummary;
//# sourceMappingURL=execution-policy.d.ts.map