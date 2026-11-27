import { AcpCliClient, type AcpCliAgentType } from "./acp-cli-client.js";
import { StdioNativeRuntimeAdapter } from "./stdio-native-runtime-adapter.js";
export declare class AcpCliRuntimeAdapter extends StdioNativeRuntimeAdapter {
    private readonly acp;
    constructor(agentType: AcpCliAgentType, acp?: AcpCliClient);
    setNativePermissionPreset(id: string, preset: string): Promise<import("./types.js").UnifiedSessionSummary>;
}
//# sourceMappingURL=acp-cli-runtime-adapter.d.ts.map