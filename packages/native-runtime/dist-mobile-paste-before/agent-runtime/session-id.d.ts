import type { AgentType } from "./types.js";
export declare function encodeUnifiedSessionId(agentType: AgentType, nativeSessionId: string): string;
export declare function decodeUnifiedSessionId(id: string): {
    agentType: AgentType;
    nativeSessionId: string;
};
//# sourceMappingURL=session-id.d.ts.map