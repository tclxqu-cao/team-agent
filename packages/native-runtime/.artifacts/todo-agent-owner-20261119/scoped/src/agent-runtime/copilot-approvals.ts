import { createHash } from "node:crypto";
import type { AgentEvent } from "@agent/core";
import { ActionType, ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputResponseKind,
  ToolCallCancellationReason, ToolCallConfirmationReason, type ChatInputAnswer, type ChatInputQuestion,
  type ChatState, type InputRequestResponsePart, type StateAction, type ToolCallConfirmationState } from "@microsoft/agent-host-protocol";
import { copilotText } from "./copilot-events.js";
import type { CopilotAhpConnection } from "./copilot-ahp-connection.js";
import type { RuntimeQuestionAnswer } from "./types.js";

type AskEvent = Extract<AgentEvent, { type: "ask_user" }>;
interface PendingQuestion { host: CopilotAhpConnection; chat: string; turn: string; target: string; question?: string; event: AskEvent }

export function isCopilotQuestionId(id: string): boolean { return /^copilot:[a-f0-9]{64}$/.test(id); }

/** Reflect native requests; never auto-approve or change the VS Code policy. */
export class CopilotApprovals {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly answering = new Set<string>();

  events(host: CopilotAhpConnection, chat: ChatState): AskEvent[] {
    const events: AskEvent[] = [];
    const turn = chat.activeTurn;
    for (const [id, pending] of this.pending) if (pending.host === host && pending.chat === chat.resource) this.pending.delete(id);
    if (!turn) return events;
    const add = (target: string, question: string | undefined, event: Omit<AskEvent, "type" | "questionId">) => {
      const id = `copilot:${createHash("sha256").update(`${host.instanceId}:${chat.resource}:${turn.id}:${target}:${question ?? ""}`).digest("hex")}`;
      const ask: AskEvent = { type: "ask_user", questionId: id, ...event };
      this.pending.set(id, { host, chat: chat.resource, turn: turn.id, target, question, event: ask });
      events.push(ask);
    };
    for (const part of turn.responseParts) {
      if (part.kind === "toolCall" && ["pending-confirmation", "pending-result-confirmation"].includes(part.toolCall.status)) {
        const tool = part.toolCall as ToolCallConfirmationState;
        const options = "options" in tool && tool.options?.length ? tool.options.map(option => ({ label: option.label, description: option.kind }))
          : [{ label: "允许一次", description: "允许这次原生操作" }, { label: "拒绝", description: "拒绝这次操作" }];
        add(tool.toolCallId, undefined, { question: `${tool.displayName || tool.toolName}\n${copilotText(tool.invocationMessage)}${typeof tool.toolInput === "string" ? `\n${tool.toolInput}` : ""}`, options });
      } else if (part.kind === "inputRequest" && !part.response) {
        if (!part.request.questions?.length) add(part.request.id, undefined, { question: part.request.message ?? part.request.url ?? "VS Code 请求确认",
          options: [{ label: "确认", description: "继续" }, { label: "取消", description: "取消这次请求" }] });
        for (const question of part.request.questions ?? []) {
          if (part.request.answers?.[question.id]?.state === "submitted") continue;
          add(part.request.id, question.id, { question: [part.request.message, question.message].filter(Boolean).join("\n"),
            ...("options" in question ? { options: question.options.map(option => ({ label: option.label, description: option.description ?? "" })), multiSelect: question.kind === "multi-select" }
              : question.kind === "boolean" ? { options: [{ label: "是", description: "true" }, { label: "否", description: "false" }] } : {}) });
        }
      }
    }
    return events;
  }

  async answer(id: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    if (this.answering.has(id)) return false;
    const pending = this.pending.get(id);
    if (!pending || !pending.host.connected) return false;
    this.answering.add(id);
    try { return await this.answerPending(id, pending, answer); }
    finally { this.answering.delete(id); }
  }

  private async answerPending(id: string, pending: PendingQuestion, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const chat = await pending.host.chat(pending.chat);
    const turn = chat.activeTurn;
    if (turn?.id !== pending.turn) { this.pending.delete(id); return false; }
    const tool = turn.responseParts.find(part => part.kind === "toolCall" && part.toolCall.toolCallId === pending.target);
    let action: StateAction;
    if (tool?.kind === "toolCall") {
      if (!["pending-confirmation", "pending-result-confirmation"].includes(tool.toolCall.status)) { this.pending.delete(id); return false; }
      const native = tool.toolCall as ToolCallConfirmationState;
      const options = "options" in native ? native.options : undefined;
      const index = answer.selectedIndices?.[0] ?? pending.event.options?.findIndex(option => option.label === answer.answer);
      if (index === undefined || index < 0 || index >= (options?.length ?? 2)) return false;
      const approved = options ? options[index]!.kind === "approve" : index === 0;
      action = native.status === "pending-result-confirmation" ? { type: ActionType.ChatToolCallResultConfirmed, turnId: turn.id, toolCallId: native.toolCallId, approved }
        : approved ? { type: ActionType.ChatToolCallConfirmed, turnId: turn.id, toolCallId: native.toolCallId, approved: true,
          confirmed: ToolCallConfirmationReason.UserAction, ...(options ? { selectedOptionId: options[index]!.id } : {}) }
          : { type: ActionType.ChatToolCallConfirmed, turnId: turn.id, toolCallId: native.toolCallId, approved: false,
            reason: ToolCallCancellationReason.Denied, ...(options ? { selectedOptionId: options[index]!.id } : {}) };
    } else {
      const part = turn.responseParts.find(part => part.kind === "inputRequest" && part.request.id === pending.target) as InputRequestResponsePart | undefined;
      if (!part || part.response) { this.pending.delete(id); return false; }
      const question = part.request.questions?.find(question => question.id === pending.question);
      if (question) {
        const value = this.inputAnswer(question, answer);
        if (!value) return false;
        await pending.host.dispatch(chat.resource, { type: ActionType.ChatInputAnswerChanged, requestId: part.request.id, questionId: question.id, answer: value });
        this.pending.delete(id);
        const updated = pending.host.chatState(chat.resource).activeTurn?.responseParts.find(item => item.kind === "inputRequest" && item.request.id === part.request.id) as InputRequestResponsePart | undefined;
        if (!updated || updated.response) return true;
        if (updated.request.questions?.some(q => updated.request.answers?.[q.id]?.state !== "submitted")) return true;
      }
      action = { type: ActionType.ChatInputCompleted, requestId: part.request.id,
        response: !question && (answer.selectedIndices?.[0] === 1 || answer.answer === "取消") ? ChatInputResponseKind.Cancel : ChatInputResponseKind.Accept };
    }
    // A failed/uncertain write must be refreshed before another answer is accepted.
    this.pending.delete(id);
    await pending.host.dispatch(chat.resource, action);
    return true;
  }

  private inputAnswer(question: ChatInputQuestion, answer: RuntimeQuestionAnswer): ChatInputAnswer | undefined {
    const state = ChatInputAnswerState.Submitted;
    if (question.kind === "text") return { state, value: { kind: ChatInputAnswerValueKind.Text, value: answer.answer } };
    if (question.kind === "number" || question.kind === "integer") {
      const value = Number(answer.answer);
      return Number.isFinite(value) && (question.kind !== "integer" || Number.isInteger(value)) ? { state, value: { kind: ChatInputAnswerValueKind.Number, value } } : undefined;
    }
    if (question.kind === "boolean") {
      const value = answer.selectedIndices?.[0] === 0 || ["true", "是"].includes(answer.answer) ? true
        : answer.selectedIndices?.[0] === 1 || ["false", "否"].includes(answer.answer) ? false : undefined;
      return value === undefined ? undefined : { state, value: { kind: ChatInputAnswerValueKind.Boolean, value } };
    }
    if (!("options" in question)) return undefined;
    const indices = answer.selectedIndices ?? question.options.flatMap((option, index) => [option.id, option.label].includes(answer.answer) ? [index] : []);
    if (indices.some(index => !Number.isInteger(index) || !question.options[index])) return undefined;
    const values = indices.map(index => question.options[index]!.id);
    if (question.kind === "multi-select") return { state, value: { kind: ChatInputAnswerValueKind.SelectedMany, value: values,
      ...(!values.length && answer.answer && question.allowFreeformInput ? { freeformValues: [answer.answer] } : {}) } };
    if (values.length !== 1 && !(question.allowFreeformInput && answer.answer)) return undefined;
    return { state, value: { kind: ChatInputAnswerValueKind.Selected, value: values[0] ?? "", ...(!values.length ? { freeformValues: [answer.answer] } : {}) } };
  }
}
