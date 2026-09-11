// ── @agent/core ──
// Domain interfaces and application services

// Domain interfaces
export * from './domain/agent/index.js';
export * from './domain/model/index.js';
export * from './domain/tool/index.js';
export * from './domain/mcp/index.js';
export * from './domain/skill/index.js';
export * from './domain/plugin/index.js';
export * from './domain/context/index.js';
export * from './domain/memory/index.js';
export * from './domain/session/index.js';
export * from './domain/upload/index.js';
export * from './domain/project/index.js';
export * from './domain/settings/index.js';
export * from './domain/lsp/index.js';
export * from './domain/terminal/TerminalSession.js';
export * from './domain/auth/index.js';
export * from './domain/browser-live/index.js';
export * from './domain/live-view/index.js';
export * from './infrastructure/live-view/index.js';
export * from './domain/web-console/index.js';
export * from './domain/ai-hub/index.js';
export * from './domain/file/index.js';
export * from './domain/update/index.js';

// Implementations
export { AgentLoop } from './domain/agent/AgentLoop.js';
export { AgentFactory } from './domain/agent/AgentFactory.js';
export { AgentBuilder } from './domain/agent/AgentBuilder.js';
export { ContextCompactor } from './domain/agent/ContextCompactor.js';
export type { CompactResult } from './domain/agent/ContextCompactor.js';
export type { SessionCompaction } from './domain/agent/entities.js';
export { AnthropicProvider } from './domain/model/providers/AnthropicProvider.js';
export { OpenAIProvider } from './domain/model/providers/OpenAIProvider.js';
export { DeepSeekProvider } from './domain/model/providers/DeepSeekProvider.js';
export { ModelRegistry } from './domain/model/ModelRegistry.js';
export { ToolRegistry } from './domain/tool/ToolRegistry.js';
export { ReadFileTool, WriteFileTool, BashTool, WebFetchTool, WebSearchTool, GrepTool, GlobTool, TodoAddTool, TodoUpdateTool, TodoListTool, DispatchAgentTool, type DispatchResult, WaitAgentTool, AskUserTool, type AskUserField, type AskUserRequest, type AskUserResponse, type AskUserCallback, CronCreateTool, CronDeleteTool, CronListTool, LspDiagnosticsTool, LspHoverTool, LspDefinitionTool, LspReferencesTool, RemoteProjectActionTool, registerBuiltinTools } from './domain/tool/builtin/index.js';
export { ToolPermissionGate, PermissionAwareToolExecutor, classifyToolPermission, normalizeToolPermissionMode, isToolPermissionMode, toolApprovalDecisionFromAnswer, TOOL_PERMISSION_MODES, TOOL_APPROVAL_OPTIONS, type ToolPermissionMode, type ToolApprovalDecision, type ToolPermissionGateOptions, type ToolPermissionRequest, type ToolPermissionClassification } from './domain/tool/permissions.js';
export { CheckpointAwareToolExecutor, InMemoryFileCheckpointJournal, type FileSnapshot, type IFileCheckpointJournal } from './domain/tool/checkpoints.js';
export { MCPClient } from './domain/mcp/MCPClient.js';
export { MCPManager } from './domain/mcp/MCPManager.js';
export { SkillLoader } from './domain/skill/SkillLoader.js';
export { SkillRegistry } from './domain/skill/SkillRegistry.js';
export { PluginManager } from './domain/plugin/PluginManager.js';
export { ContextLoader } from './domain/context/ContextLoader.js';
export { ContextAssembler } from './domain/context/ContextAssembler.js';
export { FileSystemMemoryStore } from './domain/memory/FileSystemMemoryStore.js';
export { InMemorySessionStore, FileSystemSessionStore } from './domain/session/SessionStore.js';
export type { RemoteToolDefinition, RemoteToolJob, RemoteToolRegistration } from './domain/remote-tools/entities.js';
export type { RemoteToolStore } from './domain/remote-tools/RemoteToolStore.js';
export { SQLiteRemoteToolStore } from './infrastructure/SQLiteRemoteToolStore.js';

// Cron
export * from './domain/cron/index.js';

// Infrastructure
export * from './infrastructure/index.js';

// Opt-in durable Harness run recovery.
export type { RunCheckpoint, IRunCheckpointStore } from './domain/agent/run-checkpoint.js';
export { FileRunCheckpointStore } from './infrastructure/RunCheckpointStore.js';
export { HarnessServiceClient } from './infrastructure/HarnessServiceClient.js';
export type { HarnessModelSettings, HarnessServiceStatus } from './infrastructure/HarnessServiceClient.js';
