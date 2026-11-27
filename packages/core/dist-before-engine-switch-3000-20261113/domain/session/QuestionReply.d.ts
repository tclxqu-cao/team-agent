export interface PersistedQuestionReply {
    question: string;
    answer: string;
    /** Native async question identity, when present in a desktop reply. */
    itemId?: string;
    questionIndex?: number;
}
/** Recognize complete native answer envelopes, leaving ordinary user text alone. */
export declare function parsePersistedQuestionReplies(content: string): PersistedQuestionReply[];
export declare function questionReplyMatches(reply: PersistedQuestionReply, questionId: string, question: string): boolean;
//# sourceMappingURL=QuestionReply.d.ts.map