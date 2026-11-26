/** Shared contract for the renderer, HTTP gateway and Electron preload. */
export type {
  AgentApi,
  AgentDefinition,
  ContextPlaceholder,
  AgentCapabilities,
  CronTask,
  LSPServerConfig,
  MCPServer,
  ModelProfile,
  SessionGoal,
  SessionGoalState,
  SessionQueryIndex,
  SessionQueryIndexEntry,
  ThreadGoalInfo,
  NativeComposerCatalog,
  NativeGoalMutation,
  NativeSessionGoal,
  RuntimeBackgroundJob,
  RuntimeBackgroundJobOutput,
  RuntimeBackgroundJobStopResult,
  UnifiedSessionSummary,
} from "../../contracts/agent-api";

/** Synthetic project id the web shell files every session under. */
export const WEB_DEFAULT_PROJECT_ID = "default";
