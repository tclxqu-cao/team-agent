import type { Message } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
export declare function decodeQoderHistory(rows: NativeJsonPacket[], sessionId: string): Message[];
/** Native JSONL is authoritative; ACP session/load streams history beyond its RPC response. */
export declare class QoderSessionHistory {
    private readonly root;
    constructor(root?: string);
    private rows;
    read(id: string): Promise<Message[]>;
}
//# sourceMappingURL=qoder-session-history.d.ts.map