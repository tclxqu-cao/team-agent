export interface PersistedQuestionReply {
  question: string;
  answer: string;
  /** Native async question identity, when present in a desktop reply. */
  itemId?: string;
  questionIndex?: number;
}

/** Recognize complete native answer envelopes, leaving ordinary user text alone. */
export function parsePersistedQuestionReplies(content: string): PersistedQuestionReply[] {
  const legacy = /^关于“([\s\S]+?)”的回答：\r?\n([\s\S]+)$/.exec(content);
  if (legacy) {
    return legacy[1].trim() && legacy[2].trim()
      ? [{ question: legacy[1], answer: legacy[2] }]
      : [];
  }
  const envelope = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(content);
  if (!envelope) return [];
  try {
    const entries: unknown = JSON.parse(envelope[1]);
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const replies: PersistedQuestionReply[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") return [];
      const { questionItemId, question, answer } = entry;
      if (typeof questionItemId !== "string"
        || typeof question !== "string" || !question.trim()
        || typeof answer !== "string" || !answer.trim()) return [];
      const identity: unknown = JSON.parse(questionItemId);
      if (!Array.isArray(identity) || identity.length !== 3
        || identity[0] !== "request_user_input_async"
        || typeof identity[1] !== "string" || !identity[1].trim()
        || !Number.isSafeInteger(identity[2]) || identity[2] < 0) return [];
      replies.push({ question, answer, itemId: identity[1], questionIndex: identity[2] });
    }
    return replies;
  } catch {
    return [];
  }
}

export function questionReplyMatches(
  reply: PersistedQuestionReply,
  questionId: string,
  question: string,
): boolean {
  if (reply.question !== question || !questionId.includes(":async:")) return false;
  return reply.itemId === undefined
    || questionId.endsWith(`:async:${reply.itemId}:${reply.questionIndex}`);
}
