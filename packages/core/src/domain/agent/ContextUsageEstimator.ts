import type { SystemPromptSections } from '../context/entities.js';
import type { Message, ToolDefinition } from '../model/entities.js';
import type {
  ContextUsageCategory,
  ContextUsageSnapshot,
} from './entities.js';
import {
  COMPACTION_ACKNOWLEDGEMENT,
  COMPACTION_SUMMARY_PREFIX,
} from './ContextCompactor.js';

const IMAGE_TOKENS = 1000;
const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_DEFINITION_OVERHEAD_TOKENS = 4;

const CATEGORY_ORDER: ContextUsageCategory[] = [
  "systemBase",
  "environment",
  "projectContext",
  "skills",
  "memory",
  "embeddedTools",
  "conversationHistory",
  "currentUserMessage",
  "assistantMessages",
  "toolCalls",
  "toolResults",
  "images",
  "compactionSummary",
  "nativeToolDefinitions",
  "messageOverhead",
];

export interface EstimateContextUsageInput {
  requestIndex: number;
  providerId: string;
  modelId: string;
  maxTokens: number;
  messages: Message[];
  currentUserMessage: Message;
  nativeToolDefinitions: ToolDefinition[];
  systemSections: SystemPromptSections;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function findCurrentUserIndex(messages: Message[], currentUserMessage: Message): number {
  const identityIndex = messages.indexOf(currentUserMessage);
  if (identityIndex >= 0) return identityIndex;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && message.content === currentUserMessage.content) return i;
  }
  return -1;
}

function findCompactionMessageIndices(messages: Message[]): Set<number> {
  const indices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "user" || !message.content.startsWith(COMPACTION_SUMMARY_PREFIX)) continue;
    indices.add(i);
    if (
      messages[i + 1]?.role === "assistant"
      && messages[i + 1]?.content === COMPACTION_ACKNOWLEDGEMENT
    ) {
      indices.add(i + 1);
    }
  }
  return indices;
}

export function estimateContextUsage(input: EstimateContextUsageInput): ContextUsageSnapshot {
  const totals = Object.fromEntries(
    CATEGORY_ORDER.map((category) => [category, 0]),
  ) as Record<ContextUsageCategory, number>;

  totals.systemBase = estimateTextTokens(input.systemSections.systemBase);
  totals.environment = estimateTextTokens(input.systemSections.environment);
  totals.projectContext = estimateTextTokens(input.systemSections.projectContext);
  totals.skills = estimateTextTokens(input.systemSections.skills);
  totals.memory = estimateTextTokens(input.systemSections.memory);
  totals.embeddedTools = estimateTextTokens(input.systemSections.embeddedTools);
  const nonEmptySystemSections = Object.values(input.systemSections).filter(Boolean).length;
  totals.messageOverhead += estimateTextTokens("\n\n".repeat(Math.max(0, nonEmptySystemSections - 1)));

  const currentUserIndex = findCurrentUserIndex(input.messages, input.currentUserMessage);
  const compactionIndices = findCompactionMessageIndices(input.messages);

  input.messages.forEach((message, index) => {
    totals.messageOverhead += MESSAGE_OVERHEAD_TOKENS;
    totals.images += (message.images?.length ?? 0) * IMAGE_TOKENS;

    if (message.role === "system") return;
    if (compactionIndices.has(index)) {
      totals.compactionSummary += estimateTextTokens(message.content);
      return;
    }

    if (message.role === "user") {
      const category = index === currentUserIndex ? "currentUserMessage" : "conversationHistory";
      totals[category] += estimateTextTokens(message.content);
      return;
    }

    if (message.role === "assistant") {
      totals.assistantMessages += estimateTextTokens(message.content);
      for (const toolCall of message.toolCalls ?? []) {
        totals.toolCalls += estimateTextTokens(JSON.stringify(toolCall));
      }
      return;
    }

    totals.toolResults += estimateTextTokens(JSON.stringify({
      toolCallId: message.toolCallId,
      name: message.name,
      content: message.content,
    }));
  });

  if (input.nativeToolDefinitions.length > 0) {
    totals.nativeToolDefinitions = estimateTextTokens(JSON.stringify(input.nativeToolDefinitions));
    totals.messageOverhead += input.nativeToolDefinitions.length * TOOL_DEFINITION_OVERHEAD_TOKENS;
  }

  const segments = CATEGORY_ORDER.map((category) => ({
    category,
    tokens: totals[category],
  }));
  const totalTokens = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const maxTokens = Math.max(1, input.maxTokens);

  return {
    requestIndex: input.requestIndex,
    providerId: input.providerId,
    modelId: input.modelId,
    maxTokens,
    totalTokens,
    ratio: Math.min(totalTokens / maxTokens, 1),
    estimationMode: "heuristic",
    segments,
  };
}
