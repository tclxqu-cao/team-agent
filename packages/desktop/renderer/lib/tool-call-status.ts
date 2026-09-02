interface ToolCallResultState {
  result?: unknown;
}

export function hasToolCallResult(toolCall: ToolCallResultState): boolean {
  return toolCall.result !== undefined;
}

export function areToolCallsComplete(toolCalls: readonly ToolCallResultState[]): boolean {
  return toolCalls.every(hasToolCallResult);
}
