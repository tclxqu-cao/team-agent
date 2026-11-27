import type { AgentEvent } from "@agent/core";
import { harnessRecord, type HarnessRecord } from "./deepseek-harness-client.js";
import { RuntimeSessionError, type RuntimeQuestionAnswer } from "./types.js";

export interface HarnessQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}
export interface HarnessQuestionRef {
  sessionId: string;
  kind: "question" | "approval";
  requestId: string;
  itemId: string;
}
export interface HarnessAnswerItem { id: string; selected: string[]; custom?: string }

/** Opaque identities route answers to their native session, including after a broker restart. */
export function harnessQuestionId(ref: HarnessQuestionRef): string {
  return `harness:${Buffer.from(JSON.stringify([ref.sessionId, ref.kind, ref.requestId, ref.itemId])).toString("base64url")}`;
}
export function parseHarnessQuestionId(value: string): HarnessQuestionRef | null {
  if (!value.startsWith("harness:")) return null;
  try {
    const parts: unknown = JSON.parse(Buffer.from(value.slice(8), "base64url").toString());
    if (!Array.isArray(parts) || parts.length !== 4 || !parts.every(item => typeof item === "string" && item.length > 0)
      || !["question", "approval"].includes(parts[1])) return null;
    const ref = { sessionId: parts[0], kind: parts[1], requestId: parts[2], itemId: parts[3] } as HarnessQuestionRef;
    return harnessQuestionId(ref) === value ? ref : null;
  } catch { return null; }
}

export function decodeHarnessQuestions(value: unknown): HarnessQuestion[] {
  if (!Array.isArray(value) || !value.length) throw new RuntimeSessionError("Harness 提问格式无效", "NATIVE_PROTOCOL_ERROR");
  const questions = value.map(raw => {
    const item = harnessRecord(raw);
    if (typeof item.id !== "string" || !item.id || typeof item.question !== "string" || !item.question) {
      throw new RuntimeSessionError("Harness 提问缺少标识或内容", "NATIVE_PROTOCOL_ERROR");
    }
    const options = Array.isArray(item.options) ? item.options.map(rawOption => {
      const option = harnessRecord(rawOption);
      if (typeof option.label !== "string") throw new RuntimeSessionError("Harness 问题选项无效", "NATIVE_PROTOCOL_ERROR");
      return { label: option.label, description: typeof option.description === "string" ? option.description : "" };
    }) : undefined;
    return { id: item.id, question: item.question, options,
      ...(typeof item.header === "string" ? { header: item.header } : {}),
      ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
      multiSelect: item.multiSelect === true };
  });
  if (new Set(questions.map(item => item.id)).size !== questions.length) throw new RuntimeSessionError("Harness 问题标识重复", "NATIVE_PROTOCOL_ERROR");
  return questions;
}

export function harnessAskEvent(ref: HarnessQuestionRef, question: HarnessQuestion): AgentEvent {
  return { type: "ask_user", questionId: harnessQuestionId(ref),
    question: [question.header, question.question, question.detail].filter(Boolean).join("\n\n"),
    options: question.options, multiSelect: question.multiSelect };
}
export function harnessAnswer(question: HarnessQuestion, answer: RuntimeQuestionAnswer): HarnessAnswerItem {
  const indices = answer.selectedIndices;
  if (indices && (new Set(indices).size !== indices.length || (!question.multiSelect && indices.length > 1)
    || indices.some(index => !Number.isInteger(index) || index < 0 || index >= (question.options?.length ?? 0)))) {
    throw new RuntimeSessionError("问题选项无效，请重新选择", "QUESTION_ANSWER_FAILED");
  }
  const selected = indices?.map(index => question.options![index].label) ?? [];
  const custom = selected.length ? undefined : answer.answer.trim();
  if (!selected.length && !custom) throw new RuntimeSessionError("请输入回答或选择选项", "QUESTION_ANSWER_FAILED");
  return { id: question.id, selected, ...(custom ? { custom } : {}) };
}

export function harnessQuestionProjection(row: HarnessRecord): HarnessRecord {
  const projections = row.projections ? harnessRecord(row.projections) : {};
  return projections.values ? harnessRecord(projections.values) : {};
}
