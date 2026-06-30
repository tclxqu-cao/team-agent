// ── Shared types for Agent SDK ──

export interface Session {
  id: string;
  title: string;
  status: string;
  created: string;
  updated: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface AskUserQuestion {
  questionId: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
  answered?: boolean;
  answer?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  isStreaming?: boolean;
  askUser?: AskUserQuestion;
  timestamp: number;
}

/** Agent events received from SSE stream */
export interface AgentEvent {
  type: string;
  text?: string;
  message?: string;
  toolCall?: ToolCall;
  result?: { toolCallId: string; content: string; isError?: boolean };
  finalText?: string;
  questionId?: string;
  question?: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
  error?: string;
}

export interface AgentClientConfig {
  server: string;
  token: string;
}
