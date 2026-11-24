import { randomUUID } from "node:crypto";
import type { Message } from "@agent/core";
import { nativeRecord } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";

const rows = (value: unknown): NativeJsonPacket[] => Array.isArray(value) ? value.map(nativeRecord) : [];
const pendingQuestionPrefix = "zcode-pending-question:";

export interface ZCodeQuestionHistoryOptions {
  includePendingQuestions?: boolean;
  pendingInteractionIds?: ReadonlyMap<string, string>;
  pendingQuestionInputs?: ReadonlyMap<string, NativeJsonPacket>;
  handledQuestionToolIds?: ReadonlySet<string>;
}

/** Reannounced callbacks retain their native identity, including after a reply. */
export function zcodeInteractionId(method: string, params: NativeJsonPacket): string {
  const requestId = typeof params.requestId === "string" && params.requestId
    ? params.requestId : typeof params.toolCallId === "string" && params.toolCallId ? params.toolCallId : randomUUID();
  return `zcode-interaction:${Buffer.from(JSON.stringify([params.sessionId, method, requestId])).toString("base64url")}`;
}

export function isZCodeQuestionTool(name: unknown): boolean {
  return name === "AskUserQuestion";
}

export function zcodePendingQuestionId(interactionId: string, index: number): string {
  return pendingQuestionPrefix + Buffer.from(JSON.stringify([interactionId, index])).toString("base64url");
}

export function parseZCodePendingQuestionId(id: string): string | undefined {
  if (!id.startsWith(pendingQuestionPrefix)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(id.slice(pendingQuestionPrefix.length), "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && value[0]
      && Number.isInteger(value[1]) && value[1] >= 0) return value[0];
  } catch {
    return undefined;
  }
}

function questionToolCallId(part: NativeJsonPacket): string {
  return String(part.callId ?? part.callID ?? part.toolCallId ?? part.partId ?? part.id ?? "");
}

function isSettledQuestion(status: unknown): boolean {
  return status === "completed" || status === "error";
}

/** Only a still-open question in the fetched history can use a recovery snapshot. */
export function zcodePendingQuestionToolIds(history: readonly NativeJsonPacket[], handled?: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  for (const message of history) {
    if (!Array.isArray(message.parts)) continue;
    for (const value of message.parts) {
      const part = nativeRecord(value);
      if (part.type !== "tool" || !isZCodeQuestionTool(part.tool ?? part.toolName)
        || isSettledQuestion(nativeRecord(part.state).status)) continue;
      const id = questionToolCallId(part);
      if (id && !handled?.has(id)) ids.add(id);
    }
  }
  return [...ids];
}

/** Read pending AskUserQuestion identities and their input from a session snapshot. */
export function zcodePendingQuestionsFromSnapshot(value: unknown): {
  interactionIds: Map<string, string>;
  inputs: Map<string, NativeJsonPacket>;
} {
  const interactionIds = new Map<string, string>();
  const inputs = new Map<string, NativeJsonPacket>();
  const projection = nativeRecord(nativeRecord(value).projection);
  for (const permission of rows(projection.pendingPermissions)) {
    if (permission.toolName !== "AskUserQuestion") continue;
    const toolCallId = typeof permission.toolCallId === "string" ? permission.toolCallId : undefined;
    const interactionId = typeof permission.requestId === "string" ? permission.requestId : undefined;
    if (!toolCallId || !interactionId) continue;
    interactionIds.set(toolCallId, interactionId);
    inputs.set(toolCallId, nativeRecord(permission.input));
  }
  return { interactionIds, inputs };
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

/** Recover a pending card only when the native snapshot supplies its answer target. */
export function zcodeQuestionHistory(
  part: NativeJsonPacket,
  sessionId: string,
  messageId: string,
  options: ZCodeQuestionHistoryOptions = {},
): Message[] | null {
  if (!isZCodeQuestionTool(part.tool ?? part.toolName)) return null;
  const state = nativeRecord(part.state);
  const toolCallId = questionToolCallId(part);
  const stateInput = nativeRecord(state.input ?? part.input);
  const stateQuestions = rows(stateInput.questions);
  const questions = stateQuestions.length
    ? stateQuestions
    : rows(nativeRecord(options.pendingQuestionInputs?.get(toolCallId)).questions);
  if (!questions.length || questions.some(question => typeof question.question !== "string" || !question.question.trim())) return null;
  const pending = !isSettledQuestion(state.status);
  const interactionId = options.pendingInteractionIds?.get(toolCallId);
  if (pending && (!options.includePendingQuestions || !interactionId || options.handledQuestionToolIds?.has(toolCallId))) return [];
  return questions.map((question, index) => {
    const id = pending && interactionId
      ? zcodePendingQuestionId(interactionId, index)
      : `zcode-question-history:${Buffer.from(JSON.stringify([sessionId, messageId, toolCallId, index])).toString("base64url")}`;
    const answer = nativeAnswer(state, String(question.question), questions);
    return { role: "assistant", content: "", historyId: id, presentation: { question: {
      questionId: id,
      question: String(question.question),
      options: rows(question.options).map(option => ({ label: String(option.label ?? option.value ?? ""), description: typeof option.description === "string" ? option.description : "" })),
      multiSelect: question.multiSelect === true,
      status: pending ? "pending" : state.status === "completed" ? "answered" : "cancelled",
      ...(state.status === "completed" && answer !== undefined ? { answer } : {}),
    } } };
  });
}
