// ── Model Domain: Provider abstraction ──

import type { ReasoningSummarySection } from '../agent/entities.js';
import type { SessionToolResultRef } from '../session/entities.js';

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Stable, revision-scoped identity used by paged history navigation. */
  historyId?: string;
  /** Base64 data URLs for images (e.g. data:image/png;base64,...) — used for vision requests */
  images?: string[];
  /** Display-only metadata derived from an external runtime's native message format. */
  presentation?: MessagePresentation;
  name?: string;
  toolCallId?: string;
  /** tool 消息专用：该工具结果执行失败，模型应针对错误修正后重试或换方案。 */
  isError?: boolean;
  toolCalls?: ToolCall[];
  /** Revision-scoped pointer to a native tool result loaded only on expansion. */
  toolResultRef?: SessionToolResultRef;
}

export interface NativeSubagentActivity {
  taskId: string;
  parentToolCallId: string;
  agentName?: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  isBackgrounded?: boolean;
  spawnDepth?: number;
  summary?: string;
  lastToolName?: string;
  elapsedSeconds?: number;
  toolUses?: number;
  messages: Message[];
}

export interface MessageAttachment {
  type: "image";
  name: string;
  dataUrl?: string;
  unavailable?: boolean;
  /** Set when the payload was withheld by an inline-size budget, not lost. */
  omitted?: boolean;
}

export interface MessagePresentation {
  rawContent?: string;
  attachments?: MessageAttachment[];
  reasoning?: ReasoningSummarySection[];
  /** Native Codex agent-message phase used to separate progress from final answers. */
  agentMessagePhase?: "commentary" | "final_answer";
  /** Native Codex turn owning the execution details shown after this message. */
  executionTrace?: { turnId: string };
  /** Authoritative wall-clock duration for a successfully completed turn. */
  completionDurationMs?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelAttachment {
  type: "image";
  mimeType: "image/jpeg" | "image/png";
  dataUrl: string;
  width?: number;
  height?: number;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  /** Text visible to exactly the next model request, never public or durable. */
  modelContent?: string;
  /** Model-only payload. AgentLoop removes it from events and durable state. */
  modelAttachments?: ModelAttachment[];
}

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export interface StreamOptions {
  /** Owning agent session, used by stateful transports such as AI Hub. */
  sessionId?: string;
  /** Active project directory. Stateful text transports must preserve it verbatim. */
  workingDirectory?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  stopSequences?: string[];
  reasoningEffort?: ReasoningEffort;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "text_chunk"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "text_done" }
  | { type: "error"; message: string; code?: string };

export interface IModelProvider {
  readonly providerId: string;
  readonly modelId: string;

  /** Stream a chat completion, yielding events as they arrive */
  streamChat(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent>;

  /** Count tokens for the given messages */
  countTokens(messages: Message[]): Promise<number>;

  /** Runtime context size, when the server exposes it (not the training maximum). */
  getContextWindow?(): Promise<number | undefined>;
  /** Count the complete templated request, including native tool schemas. */
  countRequestTokens?(messages: Message[], tools?: ToolDefinition[]): Promise<number>;

  /** Check if the provider supports a given model */
  supportsModel(modelId: string): boolean;
}

export interface ModelProviderConfig {
  apiKey: string;
  baseUrl?: string;
  modelId: string;
  maxTokens?: number;
  temperature?: number;
  /** aihub 专用：与桌面 AI Hub 收发消息的传输实现；缺省走 ai-hub-relay.sock */
  transport?: import('../ai-hub/transport.js').AiHubTransport;
  /** Whole-request deadline in milliseconds. Undefined preserves the provider default. */
  timeoutMs?: number;
}
