import type { AgentEvent, Message, TokenUsage, ToolCall } from "@agent/core";
import type { ActiveTurn, ChatState, StringOrMarkdown, ToolCallState, Turn, UsageInfo } from "@microsoft/agent-host-protocol";
export declare function copilotText(value: StringOrMarkdown | undefined): string;
export declare function copilotToolCall(tool: ToolCallState): ToolCall;
export declare function copilotToolOutput(tool: ToolCallState): string;
export declare function copilotUsage(usage: UsageInfo | undefined): TokenUsage | undefined;
/** Native turn and part IDs remain stable across streaming and history reloads. */
export declare function copilotHistory(chat: ChatState): Message[];
/** Project authoritative reducer state so duplicate echoes cannot duplicate output. */
export declare class CopilotEventProjection {
    private readonly text;
    private readonly reasoning;
    private readonly calls;
    private readonly results;
    consume(turn: Turn | ActiveTurn): AgentEvent[];
    terminal(turn: Turn): AgentEvent;
}
//# sourceMappingURL=copilot-events.d.ts.map