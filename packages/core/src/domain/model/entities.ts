// ── Model Domain: Provider abstraction ──

import type { ReasoningSummarySection } from '../agent/entities.js';

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Base64 data URLs for images (e.g. data:image/png;base64,...) — used for vision requests */
  images?: string[];
  /** Display-only metadata derived from an external runtime's native message format. */
  presentation?: MessagePresentation;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
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
}

export interface MessagePresentation {
  rawContent?: string;
  attachments?: MessageAttachment[];
  reasoning?: ReasoningSummarySection[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export interface StreamOptions {
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
  | { type: "text_chunk"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "text_done" }
  | { type: "error"; message: string };

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

  /** Check if the provider supports a given model */
  supportsModel(modelId: string): boolean;
}

export interface ModelProviderConfig {
  apiKey: string;
  baseUrl?: string;
  modelId: string;
  maxTokens?: number;
  temperature?: number;
}
