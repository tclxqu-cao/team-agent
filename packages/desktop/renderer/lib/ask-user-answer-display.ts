import { parsePersistedQuestionReplies, questionReplyMatches } from "../../../core/src/domain/session/QuestionReply";
import type { ChatMessage } from "../stores/agentStore";

/** Present Codex's durable answer message as the same answered question card. */
export function presentQuestionAnswers(
  messages: readonly ChatMessage[],
  isCodex: boolean,
): ChatMessage[] {
  const visible = hideAnsweredQuestionEchoes(messages);
  if (!isCodex) return visible;
  const reconciled = [...visible];
  const replacements = new Map<number, ChatMessage[]>();
  const matchedCards = new Set<number>();
  visible.forEach((message, messageIndex) => {
    if (
      message.role !== "user"
      || message.askUser
      || message.isQueued
      || message.isCompactionSummary
      || message.images?.length
      || message.presentation?.attachments?.length
    ) return;
    const replies = parsePersistedQuestionReplies(message.content);
    if (!replies.length) return;
    const restored: ChatMessage[] = [];
    replies.forEach((reply, replyIndex) => {
      // Event-only cards may be restored after the durable answer. Native
      // identity can match either side; legacy text matches the nearest prior card.
      const cardIndex = visible.findLastIndex((candidate, index) => {
        const card = candidate.askUser;
        return card && !matchedCards.has(index)
          && (reply.itemId !== undefined || index < messageIndex)
          && questionReplyMatches(reply, card.questionId, card.question)
          && (!card.answered || !card.answer || card.answer === "已处理"
            || card.answer.trim() === reply.answer.trim());
      });
      if (cardIndex >= 0) {
        matchedCards.add(cardIndex);
        const cardMessage = reconciled[cardIndex];
        if (!cardMessage.askUser?.answered || cardMessage.askUser.answer !== reply.answer) {
          reconciled[cardIndex] = {
            ...cardMessage,
            askUser: { ...cardMessage.askUser!, answered: true, answer: reply.answer },
          };
        }
        return;
      }
      restored.push({
        ...message,
        id: replyIndex === 0 ? message.id : `${message.id}:question-reply:${replyIndex}`,
        askUser: {
          questionId: `answered-history:${message.id}:${replyIndex}`,
          question: reply.question,
          answered: true,
          answer: reply.answer,
        },
      });
    });
    // Retain the original one-question history identity for existing clients.
    if (replies.length === 1 && restored.length === 1) {
      restored[0].askUser!.questionId = `answered-history:${message.id}`;
    }
    replacements.set(messageIndex, restored);
  });
  return reconciled.flatMap((message, index) => replacements.get(index) ?? [message]);
}

/** Keep native answer echoes in history, but show an answer once in the chat. */
export function hideAnsweredQuestionEchoes(messages: readonly ChatMessage[]): ChatMessage[] {
  const echoes = new Map<string, number[]>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message.role !== "user"
      || message.isQueued
      || message.images?.length
      || message.presentation?.attachments?.length
    ) continue;
    const candidates = echoes.get(message.content) ?? [];
    candidates.push(index);
    echoes.set(message.content, candidates);
  }

  const hidden = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    const card = messages[index].askUser;
    // Only Codex async answers are echoed through turn/steer. Match the
    // complete question AND submitted answer, never a generic text prefix.
    if (!card?.answered || !card.questionId.includes(":async:") || !card.answer?.trim()) continue;
    const content = `关于“${card.question}”的回答：\n${card.answer.trim()}`;
    const candidates = echoes.get(content);
    const echoIndex = candidates?.find((candidate) => candidate > index && !hidden.has(candidate));
    if (echoIndex !== undefined) hidden.add(echoIndex);
  }
  return messages.filter((_, index) => !hidden.has(index));
}
