import { randomUUID } from "node:crypto";
import type { Message } from "@agent/core";
import { nativeRecord } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";

const rows = (value: unknown): NativeJsonPacket[] => Array.isArray(value) ? value.map(nativeRecord) : [];

/** Reannounced callbacks retain their native identity, including after a reply. */
export function zcodeInteractionId(method: string, params: NativeJsonPacket): string {
  const requestId = typeof params.requestId === "string" && params.requestId
    ? params.requestId : typeof params.toolCallId === "string" && params.toolCallId ? params.toolCallId : randomUUID();
  return `zcode-interaction:${Buffer.from(JSON.stringify([params.sessionId, method, requestId])).toString("base64url")}`;
}

export function isZCodeQuestionTool(name: unknown): boolean {
  return name === "AskUserQuestion";
}

function nativeAnswer(state: NativeJsonPacket, question: string, questions: NativeJsonPacket[]): string | undefined {
  const answer = nativeRecord(nativeRecord(state.input).answers)[question];
  if (typeof answer === "string") return answer;
  if (Array.isArray(answer) && answer.every(value => typeof value === "string")) return answer.join(", ");
  const output = state.output;
  if (typeof output !== "string") return undefined;
  // ZCode persists the tool's human-readable answer rather than structured answers.
  const marker = `"${question}"="`;
  const start = output.indexOf(marker);
  if (start < 0) return undefined;
  const from = start + marker.length;
  const boundaries = [
    '". You can now continue with the user\'s answers in mind.',
    '". Continue with the provided answers and use your best judgment for the unanswered questions; do not invent user preferences.',
    ...questions.map(next => `", "${String(next.question)}"="`),
  ];
  const end = Math.min(...boundaries.map(boundary => output.indexOf(boundary, from)).filter(index => index >= 0));
  return Number.isFinite(end) ? output.slice(from, end) : undefined;
}

/** Pending questions are live events; settled questions are read-only native history. */
export function zcodeQuestionHistory(part: NativeJsonPacket, sessionId: string, messageId: string): Message[] | null {
  if (!isZCodeQuestionTool(part.tool ?? part.toolName)) return null;
  const state = nativeRecord(part.state);
  const questions = rows(nativeRecord(state.input ?? part.input).questions);
  if (!questions.length || questions.some(question => typeof question.question !== "string" || !question.question.trim())) return null;
  if (state.status !== "completed" && state.status !== "error") return [];
  const toolCallId = String(part.callID ?? part.toolCallId ?? part.id);
  return questions.map((question, index) => {
    const id = `zcode-question-history:${Buffer.from(JSON.stringify([sessionId, messageId, toolCallId, index])).toString("base64url")}`;
    const answer = nativeAnswer(state, String(question.question), questions);
    return { role: "assistant", content: "", historyId: id, presentation: { question: {
      questionId: id,
      question: String(question.question),
      options: rows(question.options).map(option => ({ label: String(option.label ?? option.value ?? ""), description: typeof option.description === "string" ? option.description : "" })),
      multiSelect: question.multiSelect === true,
      status: state.status === "completed" ? "answered" : "cancelled",
      ...(state.status === "completed" && answer !== undefined ? { answer } : {}),
    } } };
  });
}
