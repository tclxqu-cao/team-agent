import type { AskUserRequest, AskUserResponse, AgentEvent } from "@agent/core";

type EmitFn = (event: AgentEvent, sid?: string) => void;

/**
 * Manages ask_user lifecycle: creating questions, tracking pending promises,
 * and resolving them when the user responds via IPC.
 *
 * Extracted from AgentHost to reduce its responsibility count.
 */
export class QuestionManager {
  private pendingQuestions = new Map<
    string,
    {
      resolve: (response: AskUserResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly emit: EmitFn) {}

  /**
   * Create a new question: emit the ask_user event to the renderer
   * and return a promise that resolves when the user answers.
   */
  create(request: AskUserRequest, sessionId: string): Promise<AskUserResponse> {
    const questionId = crypto.randomUUID();
    this.emit(
      {
        type: "ask_user" as any,
        questionId,
        question: request.question,
        options: request.options,
        multiSelect: request.multiSelect,
      } as AgentEvent,
      sessionId,
    );
    return new Promise<AskUserResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingQuestions.has(questionId)) {
          this.pendingQuestions.delete(questionId);
          reject(new Error("Question timed out after 5 minutes"));
        }
      }, 5 * 60 * 1000);
      this.pendingQuestions.set(questionId, { resolve, reject, timer });
    });
  }

  /**
   * Resolve a pending question with the user's answer.
   * Called from the renderer via IPC.
   * Returns true if the question was found and resolved.
   */
  answer(questionId: string, answer: string, selectedIndices?: number[]): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingQuestions.delete(questionId);
    pending.resolve({ answer, selectedIndices });
    return true;
  }

  /** Reject all pending questions (e.g. on abort) */
  rejectAll(reason = "Aborted"): void {
    for (const [, pending] of this.pendingQuestions) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingQuestions.clear();
  }
}
