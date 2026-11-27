import { type NativeRpcConnection } from "./native-rpc-client.js";
/** Native admission transfers the input to ZCode's durable guide/queue owner. */
export declare class ZCodeSteering {
    private readonly rpc;
    private readonly commands;
    constructor(rpc: NativeRpcConnection);
    steer(sessionId: string, input: string, messageId?: string): Promise<boolean>;
    private query;
    private accepted;
    private submit;
    clearSession(sessionId: string): void;
}
//# sourceMappingURL=zcode-steering.d.ts.map