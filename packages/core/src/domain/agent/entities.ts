// ── Agent Domain ──

import type { Message, ToolCall, ToolResult } from '../model/entities.js';

export type AgentEventType =
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "text_chunk"
  | "text_done"
  | "compacted"
  | "error"
  | "done"
  | "todo_update"
  | "agent_dispatch";

export interface TodoItem {
  id: string;
  title: string;
  agentName?: string;
  status: "pending" | "in-progress" | "completed";
}

export type AgentEvent =
  | { type: "thinking"; message: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | { type: "text_chunk"; text: string }
  | { type: "text_done" }
  | { type: "compacted"; summary: string; removedMessages: number }
  | { type: "error"; message: string; code?: string }
  | { type: "done"; finalText: string; usage?: TokenUsage }
  | { type: "todo_update"; todos: TodoItem[] }
  | { type: "agent_dispatch"; agentName: string; task: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentConfig {
  modelProvider: import("../model/entities.js").IModelProvider;
  toolRegistry: import("../tool/entities.js").IToolRegistry;
  toolExecutor: import("../tool/entities.js").IToolExecutor;
  contextAssembler: import("../context/entities.js").IContextAssembler;
  memoryStore: import("../memory/entities.js").IMemoryStore;
  sessionStore?: import("../session/entities.js").ISessionStore;
  workingDirectory: string;
  maxIterations: number;
  maxTokens: number;
  systemPrompt?: string;
  /** Token count threshold (0–1 fraction of maxTokens) that triggers AutoCompact. Default 0.8 */
  compactThreshold?: number;
}

export interface IAgentLoop {
  /** Run the agent loop, yielding events as they occur */
  run(input: string, sessionId: string): AsyncIterable<AgentEvent>;
  /** Abort the current run */
  abort(): void;
}

export interface IAgentFactory {
  create(config: AgentConfig): IAgentLoop;
}

// ── Agent Definitions (configurable agents) ──

/** A variable that can be referenced as {{key}} in the system prompt */
export interface ContextPlaceholder {
  key: string;
  description: string;
  defaultValue: string;
}

/** Which built-in tools, skills, MCP servers and model profile an agent uses */
export interface AgentCapabilities {
  /** Model profile ID to use. Empty string = use the globally active profile. */
  profileId: string;
  /** Built-in tool names to enable. Empty array = all tools enabled. */
  enabledTools: string[];
  /** Skill names to enable. Empty array = all skills enabled. */
  enabledSkills: string[];
  /** MCP server IDs to enable. Empty array = all connected servers. */
  enabledMCPServers: string[];
}

/** A saved agent configuration that can be activated for a session */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  /** Role setting and work instructions — supports {{key}} placeholders */
  systemPrompt: string;
  contextPlaceholders: ContextPlaceholder[];
  capabilities: AgentCapabilities;
  /** Override max iterations; 0 means use the global setting */
  maxIterations: number;
  /** Automatically use this agent for new sessions */
  isDefault: boolean;
  created: string;
  updated: string;
}

export interface IAgentDefinitionStore {
  get(id: string): Promise<AgentDefinition | null>;
  list(): Promise<AgentDefinition[]>;
  create(agent: AgentDefinition): Promise<AgentDefinition>;
  update(id: string, update: Partial<Omit<AgentDefinition, 'id' | 'created'>>): Promise<AgentDefinition>;
  delete(id: string): Promise<void>;
}
