import type { AgentEvent, Message } from "@agent/core";
import type { ToolPart } from "@opencode-ai/sdk";
import { array, record } from "./opencode-v2-codec.js";

export const OPENCODE_QUESTION_ASKED = "agentroam:opencode-question-asked";
export const OPENCODE_QUESTION_RESOLVED = "agentroam:opencode-question-resolved";

export interface OpenCodeQuestion {
  key: string;
  question: string;
  multiSelect: boolean;
  options: Array<{ value: string; label: string; description: string }>;
}

export interface OpenCodeQuestionRequest {
  id: string;
  sessionID: string;
  protocol: "form" | "question";
  questions: OpenCodeQuestion[];
}

export type OpenCodeQuestionEvent =
  | { type: typeof OPENCODE_QUESTION_ASKED; properties: OpenCodeQuestionRequest }
  | { type: typeof OPENCODE_QUESTION_RESOLVED; properties: { sessionID: string; id: string } };

export interface OpenCodeQuestionClient {
  list(sessionID: string, directory: string): Promise<OpenCodeQuestionRequest[]>;
  reply(request: OpenCodeQuestionRequest, answers: string[][], directory: string): Promise<void>;
}

/** OpenCode 2's question tool uses Form; generic forms are outside this port. */
export function openCodeFormQuestion(value: unknown): OpenCodeQuestionRequest | null {
  const form = record(value);
  if (!form.metadata || record(form.metadata).kind !== "question") return null;
  if (typeof form.id !== "string" || typeof form.sessionID !== "string") throw new Error("Invalid OpenCode question identity");
  const questions = array(form.fields).map((value): OpenCodeQuestion => {
    const field = record(value);
    if (typeof field.key !== "string" || (field.type !== "string" && field.type !== "multiselect")) {
      throw new Error("Unsupported OpenCode question field");
    }
    return {
      key: field.key,
      question: String(field.description ?? field.title ?? ""),
      multiSelect: field.type === "multiselect",
      options: array(field.options ?? []).map((value) => {
        const option = record(value);
        if (typeof option.value !== "string" || typeof option.label !== "string") throw new Error("Invalid OpenCode question option");
        return { value: option.value, label: option.label, description: String(option.description ?? "") };
      }),
    };
  });
  if (!questions.length) throw new Error("Empty OpenCode question request");
  return { id: form.id, sessionID: form.sessionID, protocol: "form", questions };
}

/** OpenCode 1 exposes the question request directly rather than a Form. */
export function openCodeLegacyQuestion(value: unknown): OpenCodeQuestionRequest {
  const request = record(value);
  if (typeof request.id !== "string" || typeof request.sessionID !== "string") throw new Error("Invalid OpenCode question identity");
  const questions = array(request.questions).map((value, index): OpenCodeQuestion => {
    const question = record(value);
    if (typeof question.question !== "string") throw new Error("Invalid OpenCode question text");
    return { key: `q${index}`, question: question.question, multiSelect: question.multiple === true,
      options: array(question.options ?? []).map((value) => {
        const option = record(value);
        if (typeof option.label !== "string") throw new Error("Invalid OpenCode question option");
        return { value: option.label, label: option.label, description: String(option.description ?? "") };
      }),
    };
  });
  if (!questions.length) throw new Error("Empty OpenCode question request");
  return { id: request.id, sessionID: request.sessionID, protocol: "question", questions };
}

export function openCodeQuestionId(request: OpenCodeQuestionRequest, index: number): string {
  return `opencode-question:${Buffer.from(JSON.stringify([request.sessionID, request.id, index])).toString("base64url")}`;
}

export function isOpenCodeQuestionId(id: string): boolean {
  if (!id.startsWith("opencode-question:")) return false;
  try {
    const value: unknown = JSON.parse(Buffer.from(id.slice("opencode-question:".length), "base64url").toString());
    return Array.isArray(value) && value.length === 3 && typeof value[0] === "string" && typeof value[1] === "string"
      && Number.isInteger(value[2]) && value[2] >= 0;
  } catch { return false; }
}

export function openCodeQuestionCard(request: OpenCodeQuestionRequest, index: number): Extract<AgentEvent, { type: "ask_user" }> {
  const question = request.questions[index];
  return { type: "ask_user", questionId: openCodeQuestionId(request, index), question: question.question,
    options: question.options.map(({ label, description }) => ({ label, description })), multiSelect: question.multiSelect };
}

/** Preserve settled questions as cards without recreating an answerable request. */
export function openCodeQuestionHistory(part: ToolPart): Message[] | null {
  if (part.tool !== "question" || (part.state.status !== "completed" && part.state.status !== "error")) return null;
  let request: OpenCodeQuestionRequest;
  try {
    request = openCodeLegacyQuestion({ ...part.state.input, id: part.callID, sessionID: part.sessionID });
  } catch {
    return null;
  }
  const state = part.state;
  const answers: unknown = state.metadata?.answers;
  return request.questions.map((question, index) => {
    const answer: unknown = Array.isArray(answers) ? answers[index] : undefined;
    return { role: "assistant", content: "", presentation: { question: {
      questionId: `opencode-question-history:${part.sessionID}:${part.callID}:${index}`,
      question: question.question,
      options: question.options.map(({ label, description }) => ({ label, description })),
      multiSelect: question.multiSelect,
      status: state.status === "completed" ? "answered" : "cancelled",
      ...(state.status === "completed" ? { answer: Array.isArray(answer) && answer.every((value) => typeof value === "string")
        ? answer.join(", ") : state.output } : {}),
    } } };
  });
}

export function createOpenCodeQuestionClient(
  baseUrl: string,
  protocol: "form" | "question",
  authorization?: string,
  fetchRequest: typeof fetch = fetch,
): OpenCodeQuestionClient {
  const call = async (path: string, directory: string, body?: unknown): Promise<unknown> => {
    const url = new URL(path, baseUrl);
    // Legacy OpenCode routes resolve the project instance from directory.
    if (protocol === "question") url.searchParams.set("directory", directory);
    const response = await fetchRequest(url, { method: body === undefined ? "GET" : "POST",
      headers: { Accept: "application/json", ...(authorization ? { Authorization: authorization } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`OpenCode question HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  return {
    async list(sessionID, directory) {
      if (protocol === "form") {
        const result = record(await call(`/api/session/${encodeURIComponent(sessionID)}/form`, directory));
        return array(result.data).flatMap((form) => {
          const question = openCodeFormQuestion(form);
          return question?.sessionID === sessionID ? [question] : [];
        });
      }
      return array(await call("/question", directory)).map(openCodeLegacyQuestion).filter((question) => question.sessionID === sessionID);
    },
    async reply(request, answers, directory) {
      if (protocol === "form") {
        const answer = Object.fromEntries(request.questions.map((question, index) => [question.key,
          question.multiSelect ? answers[index] : answers[index][0]]));
        await call(`/api/session/${encodeURIComponent(request.sessionID)}/form/${encodeURIComponent(request.id)}/reply`, directory, { answer });
      } else {
        await call(`/question/${encodeURIComponent(request.id)}/reply`, directory, { answers });
      }
    },
  };
}
