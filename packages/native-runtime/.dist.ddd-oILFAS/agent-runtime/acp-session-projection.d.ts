import { type AgentEvent, type Message } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { NativeReasoningEffort, RuntimeModelInfo } from "./types.js";
export declare function acpRecords(value: unknown): NativeJsonPacket[];
export declare function acpText(value: unknown): string;
export declare function acpConfig(result: NativeJsonPacket, category: string): NativeJsonPacket | undefined;
export declare function acpChoices(config: NativeJsonPacket | undefined): NativeJsonPacket[];
export declare function acpReasoningEffort(value: unknown): NativeReasoningEffort | undefined;
export declare function acpModels(result: NativeJsonPacket): RuntimeModelInfo[];
/** Projects replay and live transcript updates into the same message shape. */
export declare class AcpSessionProjection {
    readonly messages: Message[];
    private current?;
    private readonly tools;
    appendUser(input: string, images?: string[]): void;
    finishTurn(): void;
    private appendChunk;
    update(update: NativeJsonPacket, live?: boolean): AgentEvent[];
    private appendThought;
    private toolUpdate;
}
//# sourceMappingURL=acp-session-projection.d.ts.map