export declare const AGENT_TYPES: readonly ["customer-agent", "codex", "claude-code", "opencode", "deepseek-harness", "qoder", "zcode", "workbuddy", "copilot", "grok", "agy"];
export type AgentType = typeof AGENT_TYPES[number];
export type NativeAgentType = Exclude<AgentType, "customer-agent">;
export declare const NATIVE_AGENT_TYPES: readonly NativeAgentType[];
export declare function isAgentType(value: unknown): value is AgentType;
export declare function isNativeAgentType(value: unknown): value is NativeAgentType;
export declare function supportsPromptFileAttachments(value: unknown): boolean;
//# sourceMappingURL=agent-type.d.ts.map