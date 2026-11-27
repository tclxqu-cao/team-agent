import type { AgentEvent } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
type ProgressEvent = Extract<AgentEvent, {
    type: "runtime_progress";
}>;
export declare function zcodeModelProgress(payload: NativeJsonPacket): ProgressEvent | undefined;
export {};
//# sourceMappingURL=zcode-model-progress.d.ts.map