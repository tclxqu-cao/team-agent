interface ToolCallResultState {
  result?: unknown;
  resultRef?: unknown;
}

export function hasToolCallResult(toolCall: ToolCallResultState): boolean {
  return toolCall.result !== undefined || toolCall.resultRef !== undefined;
}

export function areToolCallsComplete(toolCalls: readonly ToolCallResultState[]): boolean {
  return toolCalls.every(hasToolCallResult);
}
