import { type AgentType, type Message } from "@agent/core";
export declare function supportsContextFork(agentType: AgentType): boolean;
/** Only the final persisted assistant response in a completed turn is a cutoff. */
export declare function contextForkPoints(messages: Message[], running: boolean): Message[];
//# sourceMappingURL=context-session-fork.d.ts.map