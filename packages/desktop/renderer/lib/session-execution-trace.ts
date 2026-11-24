import type { ChatMessage } from "../stores/agentStore";
import { validCompletionDurationMs } from "./message-actions";

export interface SessionExecutionGroup {
  id: string;
  messages: ChatMessage[];
  isRunning: boolean;
  durationMs?: number;
}

export type SessionExecutionMessage = ChatMessage & { executionGroup?: SessionExecutionGroup };

export function sessionExecutionActivity(messages: readonly SessionExecutionMessage[], running: boolean):
  { kind: "none" } | { kind: "pending" } | { kind: "message"; messageId: string } {
  if (!running) return { kind: "none" };
  const last = messages.findLast((message) => !message.isQueued && message.role !== "tool" && !message.isCompactionSummary);
  if (!last || last.role === "user") return { kind: "pending" };
  if (last.askUser) return { kind: last.askUser.answered || last.askUser.cancelled ? "pending" : "none" };
  if (last.presentation?.agentMessagePhase === "final_answer") return { kind: "none" };
  if (last.executionTrace?.turnId.startsWith("engine-frozen:")) return { kind: "none" };
  if (last.executionGroup && !last.executionGroup.isRunning) return { kind: "pending" };
  return last.executionTrace || last.executionGroup || last.toolCalls?.length || last.presentation?.reasoning?.length
    ? { kind: "message", messageId: last.id } : { kind: "none" };
}

function isExecutionMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && !message.askUser && !message.widget
    && !message.isCompactionSummary && !message.executionTrace && !message.images?.length
    && !message.presentation?.attachments?.length && !message.agentName;
}

function hasExecutionContent(message: ChatMessage): boolean {
  return Boolean(message.content.trim() || message.toolCalls?.length
    || message.presentation?.reasoning?.some((section) => section.text.trim()));
}

function startsTurn(message: ChatMessage): boolean {
  return message.role === "user" && !message.isCompactionSummary
    && !message.isQueued && !message.isSteered;
}

/** Group by message semantics. Runtime adapters retain ownership of native history. */
export function groupSessionExecutionMessages(
  messages: readonly ChatMessage[],
  isRunning: boolean,
): SessionExecutionMessage[] {
  const result: SessionExecutionMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const user = messages[index++];
    const anchored = startsTurn(user);
    const owner = user.presentation?.executionTrace?.turnId ?? user.historyPrefixId;
    // Fold a prefix only with native ownership or a verified complete-history scope.
    const ownedPrefix = !anchored && isExecutionMessage(user) && Boolean(owner);
    if (anchored || !ownedPrefix) result.push(user);
    if (!anchored && !ownedPrefix) continue;
    const start = ownedPrefix ? index - 1 : index;
    let end = index;
    while (end < messages.length && !startsTurn(messages[end])) {
      const nextOwner = messages[end].presentation?.executionTrace?.turnId;
      if (owner && nextOwner && owner !== nextOwner) break;
      end++;
    }
    const turn = messages.slice(start, end);
    // A lazy trace already owns this turn's progress. Preserve its data and anchors.
    if (turn.some((message) => message.executionTrace)) {
      result.push(...turn);
      index = end;
      continue;
    }
    const turnMessages = anchored ? [user, ...turn] : turn;
    const durationMs = turnMessages.reduceRight<number | undefined>((duration, message) => (
      duration ?? validCompletionDurationMs(message.presentation?.completionDurationMs)
    ), undefined) ?? turnMessages.reduceRight<number | undefined>((duration, message) => (
      duration ?? validCompletionDurationMs(message.presentation?.runResult?.durationMs)
    ), undefined);
    const running = isRunning && end === messages.length && durationMs === undefined;
    const isAnswer = (message: ChatMessage) => (
      isExecutionMessage(message) && Boolean(message.content.trim())
      && !message.toolCalls?.length && message.presentation?.agentMessagePhase !== "commentary"
    );
    const explicitFinal = turn.findLastIndex((message) => (
      isAnswer(message) && message.presentation?.agentMessagePhase === "final_answer"
    ));
    const lastOutput = turn.findLastIndex((message) => (
      isExecutionMessage(message) && Boolean(message.content.trim() || message.toolCalls?.length)
    ));
    const finalIndex = explicitFinal >= 0 ? explicitFinal
      : !running && lastOutput >= 0 && isAnswer(turn[lastOutput]) ? lastOutput : -1;
    let pending: ChatMessage[] = [];
    let block = 0;
    const flush = () => {
      if (pending.length === 0) return;
      const id = `session-execution:${owner ?? user.id}:${block++}`;
      result.push({
        id, role: "assistant", content: "", timestamp: user.timestamp,
        executionGroup: { id, messages: pending, isRunning: running, durationMs },
      });
      pending = [];
    };
    turn.forEach((message, turnIndex) => {
      if (!isExecutionMessage(message)) {
        // Questions, widgets, compaction and engine boundaries remain visible and ordered.
        flush();
        result.push(message);
        return;
      }
      if (turnIndex === finalIndex) {
        const reasoning = message.presentation?.reasoning;
        if (reasoning?.some((section) => section.text.trim())) {
          pending.push({
            ...message, id: `${message.id}:reasoning`, content: "",
            presentation: { reasoning },
          });
        }
        flush();
        result.push(reasoning?.length
          ? { ...message, presentation: { ...message.presentation, reasoning: undefined } }
          : message);
      } else if (hasExecutionContent(message)) {
        pending.push(message.content.trim() ? {
          ...message,
          presentation: { ...message.presentation, agentMessagePhase: "commentary" },
        } : message);
      }
    });
    flush();
    index = end;
  }
  return result;
}
