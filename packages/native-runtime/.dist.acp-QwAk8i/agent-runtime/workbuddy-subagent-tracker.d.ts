import type { AgentEvent } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
/** Native WorkBuddy child streams share the parent's channel, not its answer. */
export declare class WorkBuddySubagentTracker {
    private readonly tasks;
    stopActive(terminal: "failed" | "stopped"): AgentEvent[];
    consume(packet: NativeJsonPacket): AgentEvent[];
    private results;
    private update;
}
//# sourceMappingURL=workbuddy-subagent-tracker.d.ts.map