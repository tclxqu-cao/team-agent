import type { AskUserRequest, AskUserResponse, AgentEvent } from "@agent/core";
type EmitFn = (event: AgentEvent, sid?: string) => void;
/**
 * Manages ask_user lifecycle: creating questions, tracking pending promises,
 * and resolving them when the user responds via IPC.
 *
 * Extracted from AgentHost to reduce its responsibility count.
 */
export declare class QuestionManager {
    private readonly emit;
    private pendingQuestions;
    constructor(emit: EmitFn);
    /**
     * Create a new question: emit the ask_user event to the renderer
     * and return a promise that resolves when the user answers.
     */
    create(request: AskUserRequest, sessionId: string): Promise<AskUserResponse>;
    /**
     * Resolve a pending question with the user's answer.
     * Called from the renderer via IPC.
     * Returns true if the question was found and resolved.
     */
    answer(questionId: string, answer: string, selectedIndices?: number[]): boolean;
    answerLatest(sessionId: string, answer: string): boolean;
    /** Reject all pending questions (e.g. on abort) */
    rejectAll(reason?: string): void;
}
export {};
//# sourceMappingURL=question-manager.d.ts.map