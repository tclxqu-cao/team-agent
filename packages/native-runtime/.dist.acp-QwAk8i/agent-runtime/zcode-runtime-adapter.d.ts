import { StdioNativeRuntimeAdapter, type NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
export declare class ZCodeRuntimeAdapter extends StdioNativeRuntimeAdapter {
    private readonly zcode;
    constructor(zcode?: NativeSessionProtocol);
    getSessionSummary(id: string): Promise<import("./types.js").UnifiedSessionSummary | import("./types.js").UnifiedSessionDetail>;
    steer(id: string, input: string, messageId?: string): Promise<boolean>;
}
//# sourceMappingURL=zcode-runtime-adapter.d.ts.map