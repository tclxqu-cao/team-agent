import { parsePersistedQuestionReplies, questionReplyMatches, type Message } from "@agent/core";

type Item = Record<string, unknown> & { type: string; id?: string };
type Turn = { id: string; status: string; items: Item[] };

export function codexAsyncQuestionId(threadId: string, itemId: string, index: number): string {
  return `codex:${threadId}:async:${itemId}:${index}`;
}

export function parseCodexAsyncQuestionId(id: string): { threadId: string; itemId: string; index: number } | null {
  const match = /^codex:([^:]+):async:(.+):(\d+)$/.exec(id);
  if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
  return { threadId: match[1], itemId: match[2], index: Number(match[3]) };
}

/** Native async questions remain answerable after the requesting turn completes. */
export function codexQuestionHistory(turns: readonly Turn[], threadId?: string): Map<string, Message[]> {
  const cards = new Map<string, Message[]>();
  const seen: Message[] = [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage" && item.delivery === "async" && item.id && Array.isArray(item.questions)) {
        if (cards.has(item.id)) continue;
        const messages: Message[] = item.questions.flatMap((value, index) => {
          if (!value || typeof value !== "object") return [];
          const question = value as { title?: unknown; options?: unknown };
          if (typeof question.title !== "string" || !question.title.trim()) return [];
          const questionId = codexAsyncQuestionId(threadId ?? turn.id, item.id!, index);
          return [{
            role: "assistant" as const, content: question.title,
            presentation: {
              nativeMessageId: `question:${questionId}`,
              question: {
                questionId, question: question.title,
                options: Array.isArray(question.options)
                  ? question.options.flatMap(label => typeof label === "string" ? [{ label, description: "" }] : [])
                  : [],
                multiSelect: false,
                status: turn.status === "interrupted" || turn.status === "failed" ? "cancelled" as const : "pending" as const,
              },
            },
          }];
        });
        cards.set(item.id, messages);
        seen.push(...messages);
      } else if (item.type === "userMessage" && Array.isArray(item.content)) {
        const text = item.content.flatMap(value => {
          const part = value as { type?: string; text?: string } | null;
          return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
        }).join("\n");
        for (const reply of parsePersistedQuestionReplies(text)) {
          const card = [...seen].reverse().find(message => {
            const question = message.presentation!.question!;
            return question.status !== "answered" && questionReplyMatches(reply, question.questionId, question.question);
          });
          if (card) Object.assign(card.presentation!.question!, { status: "answered", answer: reply.answer });
        }
      }
    }
  }
  return cards;
}

export function codexQuestionReply(id: string, question: string, answer: string): string {
  const identity = parseCodexAsyncQuestionId(id);
  if (!identity) throw new Error("Invalid Codex async question identity");
  return `<send_user_message_question_reply>\n${JSON.stringify([{
    questionItemId: JSON.stringify(["request_user_input_async", identity.itemId, identity.index]), question, answer,
  }])}\n</send_user_message_question_reply>`;
}
