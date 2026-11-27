/**
 * Manages ask_user lifecycle: creating questions, tracking pending promises,
 * and resolving them when the user responds via IPC.
 *
 * Extracted from AgentHost to reduce its responsibility count.
 */
export class QuestionManager {
    constructor(emit) {
        this.emit = emit;
        this.pendingQuestions = new Map();
    }
    /**
     * Create a new question: emit the ask_user event to the renderer
     * and return a promise that resolves when the user answers.
     */
    create(request, sessionId) {
        const questionId = crypto.randomUUID();
        this.emit({
            type: "ask_user",
            questionId,
            question: request.question,
            options: request.options,
            fields: request.fields,
            multiSelect: request.multiSelect,
        }, sessionId);
        return new Promise((resolve, reject) => {
            this.pendingQuestions.set(questionId, { sessionId, resolve, reject });
        });
    }
    /**
     * Resolve a pending question with the user's answer.
     * Called from the renderer via IPC.
     * Returns true if the question was found and resolved.
     */
    answer(questionId, answer, selectedIndices) {
        const pending = this.pendingQuestions.get(questionId);
        if (!pending)
            return false;
        this.pendingQuestions.delete(questionId);
        pending.resolve({ answer, selectedIndices });
        return true;
    }
    answerLatest(sessionId, answer) {
        const entries = Array.from(this.pendingQuestions.entries());
        for (let i = entries.length - 1; i >= 0; i--) {
            const [questionId, pending] = entries[i];
            if (pending.sessionId === sessionId) {
                return this.answer(questionId, answer);
            }
        }
        return false;
    }
    /** Reject all pending questions (e.g. on abort) */
    rejectAll(reason = "Aborted") {
        for (const [, pending] of this.pendingQuestions) {
            pending.reject(new Error(reason));
        }
        this.pendingQuestions.clear();
    }
}
//# sourceMappingURL=question-manager.js.map