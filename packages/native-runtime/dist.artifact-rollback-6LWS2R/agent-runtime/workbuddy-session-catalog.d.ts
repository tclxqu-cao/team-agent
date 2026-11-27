import type { Message } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { NativeProtocolSession } from "./stdio-native-runtime-adapter.js";
export declare function workBuddyText(value: unknown): string;
export declare function decodeWorkBuddyHistory(rows: NativeJsonPacket[]): Message[];
/** Read-only projection of WorkBuddy history and activity; no mirrored transcript or credential store. */
export declare class WorkBuddySessionCatalog {
    private readonly root;
    private readonly files;
    private readonly cache;
    constructor(root?: string);
    private nativeActivity;
    private rows;
    private summary;
    list(): Promise<NativeProtocolSession[]>;
    read(id: string): Promise<{
        session: NativeProtocolSession;
        messages: Message[];
    }>;
}
//# sourceMappingURL=workbuddy-session-catalog.d.ts.map