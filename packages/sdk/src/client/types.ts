// ── Shared types for Agent SDK ──

export interface Session {
  id: string;
  projectId?: string;
  /** 所属机器人运行时；server 端 /api/sessions 会显式打标，缺失时按 customer-agent 处理 */
  agentType?: 'customer-agent' | 'codex' | 'claude-code' | 'opencode';
  title: string;
  status: string;
  messages?: ChatMessage[];
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
  /** Chat/runtime bearer token used for normal SDK operations. */
  token: string;
}

export interface AgentRunOptions {
  agentId?: string;
  skillName?: string;
  profileId?: string;
  projectId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  context?: Record<string, unknown>;
  source?: 'sdk' | 'portfolio' | 'flow-studio';
}

export interface RemoteToolRegistration {
  scheme: string;
  purpose: string;
  url: string;
  method?: 'POST';
  /**
   * Headers forwarded by the server when invoking this remote tool.
   * These do not replace the SDK Authorization bearer token used to register
   * tools with the agent server; configure that token on AgentClient instead.
   */
  headers?: Record<string, string>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  examples?: Array<Record<string, unknown>>;
  /** Metadata for the server-side tool executor; not an override for SDK auth. */
  auth?: Record<string, unknown>;
}
