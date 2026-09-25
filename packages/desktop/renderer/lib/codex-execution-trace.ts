import type { AgentEvent, ReasoningSummarySection } from "@agent/core";
import type { ChatMessage } from "../stores/agentStore";
import { mergeReasoningSummaryDelta } from "./native-runtime-progress";

export type CodexLiveExecutionEvent = Extract<AgentEvent, {
  type: "text_chunk" | "reasoning_summary_delta" | "tool_call" | "tool_result";
}>;

export function groupCodexExecutionTrace(
  messages: readonly ChatMessage[],
  revision: string,
): ChatMessage[] {
  const grouped: ChatMessage[] = [];
  const nextSegmentByTurn = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    grouped.push(message);
    const tracePresentation = message.role === "user"
      ? message.presentation?.executionTrace
      : undefined;
    const turnId = tracePresentation?.turnId;
    if (!turnId) continue;
    const segmentIndex = tracePresentation.segmentIndex ?? nextSegmentByTurn.get(turnId) ?? 0;
    nextSegmentByTurn.set(turnId, Math.max(nextSegmentByTurn.get(turnId) ?? 0, segmentIndex + 1));
    const existing = messages[index + 1];
    if (
      existing?.executionTrace?.turnId === turnId
      && (existing.executionTrace.segmentIndex ?? 0) === segmentIndex
    ) {
      grouped.push({
        ...existing,
        executionTrace: { ...existing.executionTrace, turnId, revision, segmentIndex },
      });
      index += 1;
    } else {
      grouped.push({
        id: codexExecutionTraceId(turnId, segmentIndex),
        role: "assistant" as const,
        content: "",
        executionTrace: { turnId, revision, segmentIndex },
        timestamp: message.timestamp,
      });
    }
  }
  return grouped;
}

export function isCodexExecutionCarrier(message: ChatMessage): boolean {
  return message.role === "assistant" && Boolean(
    message.toolCalls?.length
    || message.presentation?.reasoning?.length
    || message.presentation?.agentMessagePhase === "commentary",
  );
}

export function codexExecutionItemCount(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => (
    total
      + (message.toolCalls?.length ?? 0)
      + (message.presentation?.reasoning?.length ?? 0)
      + (message.presentation?.agentMessagePhase === "commentary" ? 1 : 0)
  ), 0);
}

export function applyCodexExecutionToolResult(
  messages: readonly ChatMessage[],
  itemId: string,
  content: string,
  isError?: boolean,
): ChatMessage[] {
  return messages.map((message) => {
    if (!message.toolCalls?.some((toolCall) => toolCall.id === itemId)) return message;
    return {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) => toolCall.id === itemId
        ? { ...toolCall, result: content, isError }
        : toolCall),
    };
  });
}

function applyLiveEventToMessages(
  messages: readonly ChatMessage[],
  event: CodexLiveExecutionEvent,
  timestamp: number,
  turnId: string,
): ChatMessage[] {
  if (event.type === "text_chunk") {
    if (!event.text || event.messagePhase !== "commentary") return [...messages];
    const id = event.itemId
      ? `codex-trace:${turnId}:agent:${event.itemId}`
      : `codex-live-commentary:${turnId}`;
    const index = messages.findIndex((message) => message.id === id);
    if (index < 0) {
      return [...messages, {
        id,
        role: "assistant",
        content: event.text,
        presentation: { agentMessagePhase: "commentary" },
        timestamp,
      }];
    }
    return messages.map((message, messageIndex) => messageIndex === index
      ? { ...message, content: message.content + event.text }
      : message);
  }

  if (event.type === "reasoning_summary_delta") {
    const index = messages.findIndex((message) => message.presentation?.reasoning?.some(
      (section) => section.itemId === event.itemId,
    ));
    if (index < 0) {
      return [...messages, {
        id: `codex-live-reasoning:${event.itemId}`,
        role: "assistant",
        content: "",
        presentation: { reasoning: mergeReasoningSummaryDelta(undefined, event) },
        timestamp,
      }];
    }
    return messages.map((message, messageIndex) => messageIndex === index
      ? {
          ...message,
          presentation: {
            ...message.presentation,
            reasoning: mergeReasoningSummaryDelta(message.presentation?.reasoning, event),
          },
        }
      : message);
  }

  if (event.type === "tool_call") {
    const existingIndex = messages.findIndex((message) => message.toolCalls?.some(
      (toolCall) => toolCall.id === event.toolCall.id,
    ));
    if (existingIndex >= 0) {
      return messages.map((message, messageIndex) => messageIndex === existingIndex
        ? {
            ...message,
            toolCalls: message.toolCalls?.map((toolCall) => toolCall.id === event.toolCall.id
              ? { ...toolCall, name: event.toolCall.name, arguments: event.toolCall.arguments }
              : toolCall),
          }
        : message);
    }
    return [...messages, {
      id: `codex-live-tool:${event.toolCall.id}`,
      role: "assistant",
      content: "",
      toolCalls: [{ ...event.toolCall }],
      timestamp,
    }];
  }

  if (!messages.some((message) => message.toolCalls?.some(
    (toolCall) => toolCall.id === event.result.toolCallId,
  ))) return [...messages];
  return applyCodexExecutionToolResult(
    messages,
    event.result.toolCallId,
    event.result.content,
    event.result.isError,
  );
}

export function applyCodexLiveExecutionEvent(
  messages: readonly ChatMessage[],
  turnId: string,
  event: CodexLiveExecutionEvent,
  timestamp = Date.now(),
): ChatMessage[] {
  const matchingEventTraceIndex = messages.findLastIndex((message) => (
    message.executionTrace?.turnId === turnId
    && traceContainsEvent(message.executionTrace.liveMessages ?? [], event)
  ));
  const latestTraceIndex = messages.findLastIndex((message) => message.executionTrace?.turnId === turnId);
  const latestUserIndex = messages.findLastIndex((message) => message.role === "user" && !message.isQueued);
  const traceIndex = matchingEventTraceIndex >= 0
    ? matchingEventTraceIndex
    : latestTraceIndex > latestUserIndex || (latestTraceIndex >= 0 && !messages[latestUserIndex]?.isSteered)
      ? latestTraceIndex
      : -1;
  const currentLive = traceIndex >= 0
    ? messages[traceIndex].executionTrace?.liveMessages ?? []
    : [];
  const nextLive = applyLiveEventToMessages(currentLive, event, timestamp, turnId);
  if (nextLive.length === 0 && currentLive.length === 0) return [...messages];
  if (traceIndex >= 0) {
    return messages.map((message, index) => index === traceIndex
      ? {
          ...message,
          executionTrace: {
            ...message.executionTrace!,
            liveMessages: nextLive,
          },
        }
      : message);
  }

  if (nextLive === currentLive) return [...messages];
  const userIndex = latestUserIndex;
  if (userIndex < 0) return [...messages];
  const segmentIndex = messages.reduce((latest, message) => (
    message.executionTrace?.turnId === turnId
      ? Math.max(latest, message.executionTrace.segmentIndex ?? 0)
      : latest
  ), -1) + 1;
  const trace: ChatMessage = {
    id: codexExecutionTraceId(turnId, segmentIndex),
    role: "assistant",
    content: "",
    executionTrace: {
      turnId,
      revision: `live:${turnId}`,
      segmentIndex,
      liveMessages: nextLive,
    },
    timestamp,
  };
  return [
    ...messages.slice(0, userIndex + 1),
    trace,
    ...messages.slice(userIndex + 1),
  ];
}

function codexExecutionTraceId(turnId: string, segmentIndex: number): string {
  return segmentIndex === 0
    ? `codex-execution-trace:${turnId}`
    : `codex-execution-trace:${turnId}:${segmentIndex}`;
}

function traceContainsEvent(
  messages: readonly ChatMessage[],
  event: CodexLiveExecutionEvent,
): boolean {
  if (event.type === "text_chunk") {
    if (!event.itemId) return false;
    return messages.some((message) => message.id === `codex-trace:${event.turnId}:agent:${event.itemId}`);
  }
  if (event.type === "reasoning_summary_delta") {
    return messages.some((message) => message.presentation?.reasoning?.some(
      (section) => section.itemId === event.itemId,
    ));
  }
  const toolCallId = event.type === "tool_call" ? event.toolCall.id : event.result.toolCallId;
  return messages.some((message) => message.toolCalls?.some((toolCall) => toolCall.id === toolCallId));
}

export function codexExecutionSegmentMessages(
  messages: readonly ChatMessage[],
  segmentIndex: number,
): ChatMessage[] {
  const hasSegmentMetadata = messages.some(
    (message) => message.presentation?.executionTrace?.segmentIndex !== undefined,
  );
  if (!hasSegmentMetadata) return segmentIndex === 0 ? [...messages] : [];
  return messages.filter(
    (message) => message.presentation?.executionTrace?.segmentIndex === segmentIndex,
  );
}

function mergeReasoningSections(
  history: readonly ReasoningSummarySection[],
  live: readonly ReasoningSummarySection[],
): ReasoningSummarySection[] {
  const merged = new Map(history.map((section) => [
    `${section.itemId}:${section.sectionIndex}`,
    section,
  ]));
  for (const section of live) {
    const key = `${section.itemId}:${section.sectionIndex}`;
    const previous = merged.get(key);
    const text = !previous
      ? section.text
      : section.text.startsWith(previous.text)
        ? section.text
        : previous.text.startsWith(section.text)
          ? previous.text
          : section.text;
    merged.set(key, { ...section, text });
  }
  return [...merged.values()];
}

function executionKeys(message: ChatMessage): string[] {
  return [
    ...(message.presentation?.agentMessagePhase === "commentary"
      ? [`agent:${message.id}`]
      : []),
    ...(message.presentation?.reasoning ?? []).map(
      (section) => `reasoning:${section.itemId}:${section.sectionIndex}`,
    ),
    ...(message.toolCalls ?? []).map((toolCall) => `tool:${toolCall.id}`),
  ];
}

function isFallbackCommentaryMatch(left: ChatMessage, right: ChatMessage): boolean {
  return left.presentation?.agentMessagePhase === "commentary"
    && right.presentation?.agentMessagePhase === "commentary"
    && (left.id.startsWith("codex-live-commentary:")
      || right.id.startsWith("codex-live-commentary:"))
    && (left.content.startsWith(right.content) || right.content.startsWith(left.content));
}

function deduplicateExecutionMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  const commentaryById = new Map<string, number>();
  const reasoningByKey = new Map<string, { messageIndex: number; sectionIndex: number }>();
  const toolById = new Map<string, { messageIndex: number; toolIndex: number }>();

  for (const source of messages) {
    if (source.presentation?.agentMessagePhase === "commentary") {
      const existingIndex = commentaryById.get(source.id);
      if (existingIndex !== undefined) {
        const existing = result[existingIndex];
        const content = source.content.startsWith(existing.content)
          ? source.content
          : existing.content.startsWith(source.content)
            ? existing.content
            : source.content;
        result[existingIndex] = { ...existing, ...source, id: existing.id, content };
        continue;
      }
    }

    const message: ChatMessage = {
      ...source,
      toolCalls: source.toolCalls ? [] : undefined,
      presentation: source.presentation?.reasoning
        ? { ...source.presentation, reasoning: [] }
        : source.presentation,
    };

    for (const section of source.presentation?.reasoning ?? []) {
      const key = `${section.itemId}:${section.sectionIndex}`;
      const existingLocation = reasoningByKey.get(key);
      if (existingLocation) {
        const existingMessage = result[existingLocation.messageIndex];
        const existingSections = [...(existingMessage.presentation?.reasoning ?? [])];
        const existing = existingSections[existingLocation.sectionIndex];
        existingSections[existingLocation.sectionIndex] = mergeReasoningSections([existing], [section])[0];
        result[existingLocation.messageIndex] = {
          ...existingMessage,
          presentation: { ...existingMessage.presentation, reasoning: existingSections },
        };
      } else {
        const localIndex = message.presentation!.reasoning!.findIndex((candidate) => (
          candidate.itemId === section.itemId && candidate.sectionIndex === section.sectionIndex
        ));
        if (localIndex >= 0) {
          message.presentation!.reasoning![localIndex] = mergeReasoningSections(
            [message.presentation!.reasoning![localIndex]],
            [section],
          )[0];
        } else {
          message.presentation!.reasoning!.push(section);
        }
      }
    }

    for (const toolCall of source.toolCalls ?? []) {
      const existingLocation = toolById.get(toolCall.id);
      if (existingLocation) {
        const existingMessage = result[existingLocation.messageIndex];
        const existingTools = [...(existingMessage.toolCalls ?? [])];
        existingTools[existingLocation.toolIndex] = {
          ...existingTools[existingLocation.toolIndex],
          ...toolCall,
        };
        result[existingLocation.messageIndex] = { ...existingMessage, toolCalls: existingTools };
      } else {
        const localIndex = message.toolCalls!.findIndex((candidate) => candidate.id === toolCall.id);
        if (localIndex >= 0) {
          message.toolCalls![localIndex] = { ...message.toolCalls![localIndex], ...toolCall };
        } else {
          message.toolCalls!.push(toolCall);
        }
      }
    }

    const hasCommentary = message.presentation?.agentMessagePhase === "commentary";
    const hasReasoning = Boolean(message.presentation?.reasoning?.length);
    const hasTools = Boolean(message.toolCalls?.length);
    if (!hasCommentary && !hasReasoning && !hasTools) continue;

    const messageIndex = result.length;
    result.push(message);
    if (hasCommentary) commentaryById.set(message.id, messageIndex);
    for (let sectionIndex = 0; sectionIndex < (message.presentation?.reasoning?.length ?? 0); sectionIndex += 1) {
      const section = message.presentation!.reasoning![sectionIndex];
      reasoningByKey.set(`${section.itemId}:${section.sectionIndex}`, { messageIndex, sectionIndex });
    }
    for (let toolIndex = 0; toolIndex < (message.toolCalls?.length ?? 0); toolIndex += 1) {
      toolById.set(message.toolCalls![toolIndex].id, { messageIndex, toolIndex });
    }
  }
  return result;
}

function orderMergedExecutionMessages(
  merged: ChatMessage[],
  history: readonly ChatMessage[],
  live: readonly ChatMessage[],
): ChatMessage[] {
  if (merged.length < 2) return merged;

  const nodeByKey = new Map<string, number>();
  merged.forEach((message, index) => {
    for (const key of executionKeys(message)) nodeByKey.set(key, index);
  });
  const nodeIndex = (message: ChatMessage): number => {
    for (const key of executionKeys(message)) {
      const index = nodeByKey.get(key);
      if (index !== undefined) return index;
    }
    return merged.findIndex((candidate) => isFallbackCommentaryMatch(candidate, message));
  };
  const sequence = (messages: readonly ChatMessage[]): number[] => {
    const ordered: number[] = [];
    for (const message of messages) {
      const index = nodeIndex(message);
      if (index < 0 || ordered.at(-1) === index) continue;
      ordered.push(index);
    }
    return ordered;
  };

  const historyOrder = sequence(history);
  const liveOrder = sequence(live);
  const outgoing = Array.from({ length: merged.length }, () => new Set<number>());
  const indegree = Array.from({ length: merged.length }, () => 0);
  const addEdges = (ordered: number[]) => {
    for (let index = 1; index < ordered.length; index += 1) {
      const from = ordered[index - 1];
      const to = ordered[index];
      if (from === to || outgoing[from].has(to)) continue;
      outgoing[from].add(to);
      indegree[to] += 1;
    }
  };
  addEdges(historyOrder);
  addEdges(liveOrder);

  const historyRank = new Map(historyOrder.map((node, index) => [node, index]));
  const liveRank = new Map(liveOrder.map((node, index) => [node, index]));
  const compareNodes = (left: number, right: number) => {
    const leftHistory = historyRank.get(left) ?? Number.POSITIVE_INFINITY;
    const rightHistory = historyRank.get(right) ?? Number.POSITIVE_INFINITY;
    if (leftHistory !== rightHistory) return leftHistory - rightHistory;
    const leftLive = liveRank.get(left) ?? Number.POSITIVE_INFINITY;
    const rightLive = liveRank.get(right) ?? Number.POSITIVE_INFINITY;
    if (leftLive !== rightLive) return leftLive - rightLive;
    return left - right;
  };

  const ready = indegree.flatMap((value, index) => value === 0 ? [index] : []).sort(compareNodes);
  const result: ChatMessage[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    result.push(merged[node]);
    for (const next of outgoing[node]) {
      indegree[next] -= 1;
      if (indegree[next] === 0) {
        ready.push(next);
        ready.sort(compareNodes);
      }
    }
  }

  // Conflicting source orders indicate a protocol inconsistency. Keep the
  // persisted-first merge stable instead of inventing a third order.
  return result.length === merged.length ? result : merged;
}

export function mergeCodexExecutionMessages(
  history: readonly ChatMessage[],
  live: readonly ChatMessage[],
): ChatMessage[] {
  const merged = history.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    presentation: message.presentation?.reasoning
      ? { ...message.presentation, reasoning: [...message.presentation.reasoning] }
      : message.presentation,
  }));

  for (const liveMessage of live) {
    if (liveMessage.presentation?.agentMessagePhase === "commentary") {
      const targetIndex = merged.findIndex((message) => (
        message.id === liveMessage.id
        || (
          message.presentation?.agentMessagePhase === "commentary"
          && (message.id.startsWith("codex-live-commentary:")
            || liveMessage.id.startsWith("codex-live-commentary:"))
          && (liveMessage.content.startsWith(message.content)
            || message.content.startsWith(liveMessage.content))
        )
      ));
      if (targetIndex < 0) {
        merged.push(liveMessage);
      } else {
        const target = merged[targetIndex];
        const content = liveMessage.content.startsWith(target.content)
          ? liveMessage.content
          : target.content.startsWith(liveMessage.content)
            ? target.content
            : liveMessage.content;
        merged[targetIndex] = {
          ...target,
          content,
          presentation: { ...target.presentation, agentMessagePhase: "commentary" },
        };
      }
      continue;
    }
    const liveReasoning = liveMessage.presentation?.reasoning;
    if (liveReasoning?.length) {
      const targetIndex = merged.findIndex((message) => message.presentation?.reasoning?.some(
        (section) => liveReasoning.some((liveSection) => liveSection.itemId === section.itemId),
      ));
      if (targetIndex >= 0) {
        const target = merged[targetIndex];
        merged[targetIndex] = {
          ...target,
          presentation: {
            ...target.presentation,
            reasoning: mergeReasoningSections(target.presentation?.reasoning ?? [], liveReasoning),
          },
        };
      } else {
        merged.push(liveMessage);
      }
    }

    for (const liveTool of liveMessage.toolCalls ?? []) {
      const targetIndex = merged.findIndex((message) => message.toolCalls?.some(
        (toolCall) => toolCall.id === liveTool.id,
      ));
      if (targetIndex >= 0) {
        const target = merged[targetIndex];
        merged[targetIndex] = {
          ...target,
          toolCalls: target.toolCalls?.map((toolCall) => toolCall.id === liveTool.id
            ? { ...toolCall, ...liveTool }
            : toolCall),
        };
      } else {
        merged.push({
          ...liveMessage,
          id: (liveMessage.toolCalls?.length ?? 0) > 1
            ? `${liveMessage.id}:tool:${liveTool.id}`
            : liveMessage.id,
          presentation: undefined,
          toolCalls: [liveTool],
        });
      }
    }
  }
  return orderMergedExecutionMessages(deduplicateExecutionMessages(merged), history, live);
}
