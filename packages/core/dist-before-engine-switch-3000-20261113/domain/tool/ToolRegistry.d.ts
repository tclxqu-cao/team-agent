import type { ITool, IToolRegistry, IToolExecutor, ToolContext, ToolResult } from './entities.js';
export declare class ToolRegistry implements IToolRegistry, IToolExecutor {
    private readonly tools;
    register(tool: ITool): void;
    unregister(name: string): void;
    get(name: string): ITool | undefined;
    getAll(): ITool[];
    getDefinitions(): {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    }[];
    getAuthorizationPolicy(name: string): import("./entities.js").ToolAuthorizationPolicy;
    getNetworkAccess(name: string): import("./entities.js").ToolNetworkAccess;
    execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
    validate(name: string, args: Record<string, unknown>): boolean;
}
//# sourceMappingURL=ToolRegistry.d.ts.map