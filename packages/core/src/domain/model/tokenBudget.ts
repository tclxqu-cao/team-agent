import type { Message, ToolDefinition } from './entities.js';

/** Conservative fallback for mixed Chinese/English; includes serialized metadata. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 3);
}

export function estimateRequestTokens(messages: Message[], tools: ToolDefinition[] = []): number {
  return 32 + messages.reduce((sum, message) => sum + 8
    + estimateTextTokens(JSON.stringify({ ...message, images: undefined }))
    + (message.images?.length ?? 0) * 1000, 0)
    + (tools.length ? estimateTextTokens(JSON.stringify(tools)) + tools.length * 16 : 0);
}

export function truncateToTokenBudget(text: string, budget: number): string {
  if (estimateTextTokens(text) <= budget) return text;
  const suffix = "\n... (truncated)";
  if (budget < estimateTextTokens(suffix)) return "";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(text.slice(0, mid) + suffix) <= budget) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + suffix;
}
