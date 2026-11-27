import type { NativeAgentType } from "@agent/core";
export interface NativeTodoMcpConfiguration {
    command: string;
    args: string[];
    env: Record<string, string>;
    readiness?: "required" | "background";
}
export interface RuntimeTodoContext {
    serviceId: string;
    ownerId: string;
    descriptorPath: string;
    relayPath?: string;
    executionId?: string;
    model?: string;
    discoveryDirectory?: string;
}
export declare const TODO_NATIVE_INJECTION_SUPPORT: Record<NativeAgentType, string>;
export declare function nativeTodoMcpConfiguration(context: RuntimeTodoContext, readiness?: NativeTodoMcpConfiguration["readiness"]): NativeTodoMcpConfiguration;
export declare function prepareTodoInjection(context: RuntimeTodoContext, agentType: NativeAgentType): Promise<{
    status: "unsupported";
    reason: string;
    configuration?: undefined;
} | {
    status: "configured";
    configuration: NativeTodoMcpConfiguration;
    reason?: undefined;
}>;
//# sourceMappingURL=runtime-tool-injection.d.ts.map