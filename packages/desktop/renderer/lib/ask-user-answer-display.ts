import type { ChatMessage } from "../stores/agentStore";

/** Present Codex's durable answer message as the same answered question card. */
export function presentQuestionAnswers(
  messages: readonly ChatMessage[],
  isCodex: boolean,
): ChatMessage[] {
  const visible = hideAnsweredQuestionEchoes(messages);
  if (!isCodex) return visible;
  return visible.map((message) => {
    if (
      message.role !== "user"
      || message.askUser
      || message.isQueued
      || message.isCompactionSummary
      || message.images?.length
      || message.presentation?.attachments?.length
    ) return message;
    // This is the complete turn/steer envelope emitted by CodexRuntimeAdapter.
    // Formatting it never changes the durable text, user boundary or trace.
    const match = /^关于“([\s\S]+?)”的回答：\r?\n([\s\S]+)$/.exec(message.content);
    if (!match || !match[1].trim() || !match[2].trim()) return message;
    return {
      ...message,
      askUser: {
        questionId: `answered-history:${message.id}`,
        question: match[1],
        answered: true,
        answer: match[2],
      },
    };
  });
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
