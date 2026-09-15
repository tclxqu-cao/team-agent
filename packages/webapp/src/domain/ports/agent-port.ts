/**
 * Domain layer — the AgentApi port.
 *
 * The desktop renderer (presentation) only ever talks to `window.agentApi`,
 * typed by `AgentApi` in @desktop/renderer/global. That interface IS the
 * port: the Electron preload implements it over IPC, this package implements
 * it over the server's HTTP/SSE APIs. Re-export it here so web-side adapters
 * depend on the domain contract, not on desktop internals.
 */
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
  TtsStreamMetadata,
} from "../../../../desktop/renderer/global";

/** Synthetic project id the web shell files every session under. */
export const WEB_DEFAULT_PROJECT_ID = "default";
