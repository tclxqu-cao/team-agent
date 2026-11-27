import type { AgentEvent } from "@agent/core";
import { type ChatState } from "@microsoft/agent-host-protocol";
import type { CopilotAhpConnection } from "./copilot-ahp-connection.js";
import type { RuntimeQuestionAnswer } from "./types.js";
type AskEvent = Extract<AgentEvent, {
    type: "ask_user";
}>;
export declare function isCopilotQuestionId(id: string): boolean;
/** Reflect native requests; never auto-approve or change the VS Code policy. */
export declare class CopilotApprovals {
    private readonly pending;
    private readonly answering;
    events(host: CopilotAhpConnection, chat: ChatState): AskEvent[];
    answer(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    private answerPending;
    private inputAnswer;
}
export {};
//# sourceMappingURL=copilot-approvals.d.ts.map