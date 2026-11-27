import { StdioNativeRuntimeAdapter, type NativeProtocolSession, type NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import type { RuntimeHealth } from "./types.js";
export interface CopilotRuntimeProtocol extends NativeSessionProtocol {
    health(): Promise<RuntimeHealth>;
    getSessionWatchPath(id: string): Promise<string | null>;
    sessionSummary(id: string): Promise<NativeProtocolSession>;
    steer(id: string, input: string, messageId?: string): Promise<boolean>;
}
export declare class CopilotRuntimeAdapter extends StdioNativeRuntimeAdapter {
    private readonly copilot;
    constructor(copilot?: CopilotRuntimeProtocol);
    protected summary(session: NativeProtocolSession): {
        occupancy: "available" | "owned-by-customer-agent";
        canResume: boolean;
        nativeGoalSupported: boolean;
        nativeModelSelectionSupported: boolean;
        id: string;
        agentType: import("@agent/core").AgentType;
        nativeSessionId: string;
        title: string;
        cwd: string;
        projectId?: string;
        parentSessionId?: string;
        created: string;
        updated: string;
        status: "idle" | "running" | "completed" | "failed";
        sourceLabel: string;
        readOnly?: boolean;
        externalGuideSupported?: boolean;
        canDelete: boolean;
        permissionMode?: import("@agent/core").ToolPermissionMode;
        nativePermissions?: import("./types.js").NativeSessionPermissions;
        nativeMode?: {
            currentValue: string;
            canChange: boolean;
            options: Array<{
                value: string;
                label: string;
                description?: string;
            }>;
        };
        occupancyRevision?: number;
        controller?: "web" | "desktop" | null;
        goalState?: import("@agent/core").SessionGoalState;
        messageQueueVersion?: 1;
        compatibility?: import("./types.js").SessionCompatibility;
        migratedFrom?: string;
    };
    health(): Promise<RuntimeHealth>;
    getSessionSummary(id: string): Promise<{
        occupancy: "available" | "owned-by-customer-agent";
        canResume: boolean;
        nativeGoalSupported: boolean;
        nativeModelSelectionSupported: boolean;
        id: string;
        agentType: import("@agent/core").AgentType;
        nativeSessionId: string;
        title: string;
        cwd: string;
        projectId?: string;
        parentSessionId?: string;
        created: string;
        updated: string;
        status: "idle" | "running" | "completed" | "failed";
        sourceLabel: string;
        readOnly?: boolean;
        externalGuideSupported?: boolean;
        canDelete: boolean;
        permissionMode?: import("@agent/core").ToolPermissionMode;
        nativePermissions?: import("./types.js").NativeSessionPermissions;
        nativeMode?: {
            currentValue: string;
            canChange: boolean;
            options: Array<{
                value: string;
                label: string;
                description?: string;
            }>;
        };
        occupancyRevision?: number;
        controller?: "web" | "desktop" | null;
        goalState?: import("@agent/core").SessionGoalState;
        messageQueueVersion?: 1;
        compatibility?: import("./types.js").SessionCompatibility;
        migratedFrom?: string;
    }>;
    steer(id: string, input: string, messageId?: string): Promise<boolean>;
    getSessionWatchPath(id: string): Promise<string | null>;
}
//# sourceMappingURL=copilot-runtime-adapter.d.ts.map