import type { BrowserLiveSessionView } from "../../core/src/domain/browser-live/entities";
import type { LiveViewOwnershipState } from "../../core/src/domain/live-view/entities";

export interface LSPServerConfig {
  id: string;
  name: string;
  language: string;
  fileTypes: string[];
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface MCPServer {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamableHttp";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse/remote
  url?: string;
  // custom HTTP headers (streamableHttp / authenticated sse)
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface CronTask {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  recurring: boolean;
  enabled: boolean;
  label?: string;
  sessionId?: string;
  nextFireAt?: number;
  lastFiredAt?: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
}

export interface ContextPlaceholder {
  key: string;
  description: string;
  defaultValue: string;
}

export interface AgentCapabilities {
  profileId: string;
  enabledTools: string[];
  enabledSkills: string[];
  enabledMCPServers: string[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  contextPlaceholders: ContextPlaceholder[];
  capabilities: AgentCapabilities;
  maxIterations: number;
  isDefault: boolean;
  created: string;
  updated: string;
}

export interface TodoItem {
  id: string;
  title: string;
  agentName?: string;
  status: "pending" | "in-progress" | "completed";
}

export type AgentType = "customer-agent" | "codex" | "claude-code" | "opencode";

export interface UpdateStatus {
  phase: "idle" | "checking" | "up-to-date" | "available" | "unavailable" | "downloading" | "installing" | "reconnecting" | "complete" | "failed";
  currentVersion: string;
  targetVersion?: string;
  checkedAt?: number;
  progress?: number;
  message?: string;
}

export interface SessionQueryIndexEntry {
  messageId: string;
  ordinal: number;
  preview: string;
  pageToken: string;
}

export interface SessionQueryIndex {
  sessionId: string;
  revision: string;
  totalQueries: number;
  entries: SessionQueryIndexEntry[];
}

export type NativeReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeModelSelection {
  id: string;
  providerID?: string;
}

export interface RuntimeModelInfo {
  id: string;
  providerID?: string;
  displayName?: string;
  description?: string;
  reasoningEfforts?: NativeReasoningEffort[];
}

/** Per-run model/effort the composer pins onto native runtime turns. */
export interface NativeRunOptions {
  model?: RuntimeModelSelection;
  reasoningEffort?: NativeReasoningEffort;
}

export interface AgentWorkspace {
  agentType: AgentType;
  workspaceId: string;
  name: string;
  roots: string[];
  order: number;
  updatedAt?: string;
  source: "native" | "derived" | "imported";
  canCreateSession?: boolean;
}

export interface ImportAgentWorkspaceResult {
  workspace: AgentWorkspace;
  existing: boolean;
}

export interface WorkspacePage<T> {
  data: T[];
  nextCursor: string | null;
  watermark: string | null;
  stale?: boolean;
}
export type ToolPermissionMode = "request-approval" | "auto-approval" | "full-access";
export type SessionCompatibilityStatus = "checking" | "direct" | "migratable" | "incompatible";

export interface SessionCompatibility {
  status: SessionCompatibilityStatus;
  producerVersion?: string;
  readerVersion: string;
  formatKey?: string;
  reasonCode?: string;
  reason?: string;
}

export interface SessionGoal {
  id: string;
  sessionId: string;
  objective: string;
  status: "queued" | "active" | "completed" | "failed" | "cancelled";
  position: number;
  createdAt: number;
  updatedAt: number;
  sourceMessageId?: string;
  kind?: "goal" | "message";
  messagePayload?: {
    images?: string[];
    agentIds?: string[];
    agentName?: string;
  };
  iterations?: number;
  lastReason?: string;
}

export interface SessionGoalState {
  active: SessionGoal | null;
  queued: SessionGoal[];
  history: SessionGoal[];
}

/** 目标模式（thread goal）：每会话至多一个持久化目标，由服务端空闲续跑推进。 */
export interface ThreadGoalInfo {
  sessionId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UnifiedSessionSummary {
  id: string;
  agentType: AgentType;
  nativeSessionId: string;
  title: string;
  cwd: string;
  projectId?: string;
  parentSessionId?: string;
  created: string;
  updated: string;
  status: "idle" | "running" | "completed" | "failed";
  occupancy: "available" | "owned-by-customer-agent" | "owned-externally";
  sourceLabel: string;
  canResume: boolean;
  canDelete: boolean;
  permissionMode?: ToolPermissionMode;
  occupancyRevision?: number;
  controller?: "web" | "desktop" | null;
  goalState?: SessionGoalState;
  messageQueueVersion?: 1;
  compatibility?: SessionCompatibility;
  migratedFrom?: string;
}

export interface RuntimeHealth {
  agentType: AgentType;
  available: boolean;
  label: string;
  version?: string;
  error?: string;
}

export interface AgentApi {
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  // Window control (hide → background voice-wake mode, show → restore)
  hideWindow(): Promise<void>;
  showWindow(): Promise<void>;
  isWindowVisible(): Promise<boolean>;
  // Native wake-word listener (macOS Speech framework)
  wakeStart(wakeWord: string): Promise<{ ok: boolean; reason?: string }>;
  wakeStop(): Promise<{ ok: boolean }>;
  onWake(callback: (heard: string) => void): () => void;
  // Voice command captured right after the wake word fired
  onWakeCommand(callback: (payload: { text: string }) => void): () => void;
  // Two-way voice conversation mode (follow-ups without wake word)
  wakeConversation(on: boolean): Promise<{ ok: boolean; conversation: boolean }>;
  // Native one-shot dictation for the chat input
  dictationStart(): Promise<{ ok: boolean; reason?: string }>;
  dictationStop(): Promise<{ ok: boolean }>;
  onDictation(callback: (payload: { text: string; isFinal: boolean }) => void): () => void;
  onDictationError(callback: (message: string) => void): () => void;
  // Model-backed TTS via the voice service
  ttsSpeak(text: string): Promise<{ ok: boolean }>;
  ttsStop(): Promise<{ ok: boolean }>;
  ttsPlaybackEnded(generation: number): Promise<{ ok: boolean }>;
  onTtsStart(callback: (payload: TtsStreamMetadata) => void): () => void;
  onTtsPcm(callback: (payload: { generation: number; pcm: ArrayBuffer }) => void): () => void;
  onTtsStreamEnd(callback: (payload: { generation: number }) => void): () => void;
  onTtsFlush(callback: (payload: { generation: number }) => void): () => void;
  onTtsEnd(callback: (payload: { generation: number }) => void): () => void;
  run(input: string, sessionId: string, agentIds?: string[], agentName?: string, images?: string[], nativeOptions?: NativeRunOptions): Promise<unknown[]>;
  listAgentModels(agentType: AgentType): Promise<{ agentType: AgentType; models: RuntimeModelInfo[]; supported?: boolean }>;
  steer(input: string, sessionId: string, agentName?: string): Promise<boolean>;
  abort(sessionId?: string): Promise<void>;
  answerQuestion(questionId: string, answer: string, selectedIndices?: number[]): Promise<boolean>;
  subscribe(): Promise<void>;
  onEvent(callback: (event: unknown) => void): () => void;
  getSettings(): Promise<{
    revision?: number;
    modelProvider: string;
    modelId: string;
    apiKey: string;
    baseUrl: string;
    maxIterations: number;
    contextWindow: number;
    workingDirectory: string;
    profiles: ModelProfile[];
    activeProfileId: string;
  }>;
  setSetting(key: string, value: string): Promise<void>;
  saveSettings(settings: Record<string, unknown>): Promise<void>;
  setActiveProfile(profileId: string): Promise<void>;
  openFileDialog(): Promise<string | null>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<boolean>;
  listProjects(): Promise<unknown[]>;
  getProject(id: string): Promise<unknown>;
  createProject(name: string, description?: string): Promise<unknown>;
  updateProject(id: string, update: Record<string, unknown>): Promise<unknown>;
  deleteProject(id: string): Promise<void>;
  checkProjectPath(path: string): Promise<boolean>;
  listProjectRoots(): Promise<string[]>;
  listProjectDirectories(path: string): Promise<Array<{
    name: string;
    path: string;
    kind: "directory" | "file";
    hasChildren: boolean;
  }>>;
  listSessions(projectId?: string): Promise<UnifiedSessionSummary[]>;
  listAgentWorkspaces(
    agentType: AgentType,
    query?: { cursor?: string | null; limit?: number; refresh?: boolean; since?: string | null },
  ): Promise<WorkspacePage<AgentWorkspace>>;
  importAgentWorkspace(
    agentType: AgentType,
    path: string,
    name?: string,
  ): Promise<ImportAgentWorkspaceResult>;
  listAgentWorkspaceSessions(
    agentType: AgentType,
    workspaceId: string,
    query?: { cursor?: string | null; limit?: number; refresh?: boolean },
  ): Promise<WorkspacePage<UnifiedSessionSummary>>;
  listChildSessions(parentId: string): Promise<unknown[]>;
  getSession(
    id: string,
    query?: { before?: string; after?: string; anchor?: string; limit?: number; view?: "core" | "trace"; revision?: string; turnId?: string },
  ): Promise<unknown>;
  getSessionToolResult(
    id: string,
    ref: { turnId: string; itemId: string; revision: string },
  ): Promise<{ turnId: string; itemId: string; revision: string; byteSize: number; isError?: boolean; content: string }>;
  getSessionQueryIndex?(id: string): Promise<SessionQueryIndex>;
  observeSession?(
    id: string,
    callback: (change: { type: "session_history_changed"; revision: number }) => void,
    onError?: () => void,
  ): () => void;
  setSessionPermissionMode(id: string, mode: ToolPermissionMode): Promise<unknown>;
  getSessionGoals(id: string): Promise<SessionGoalState>;
  enqueueSessionGoal(id: string, objective: string, sourceMessageId?: string): Promise<SessionGoalState>;
  reorderSessionGoals(id: string, orderedIds: string[]): Promise<SessionGoalState>;
  cancelSessionGoal(id: string, goalId: string): Promise<SessionGoalState>;
  enqueueSessionMessage(
    id: string,
    message: { sourceMessageId: string; content: string; images?: string[]; agentIds?: string[]; agentName?: string },
  ): Promise<SessionGoalState>;
  updateSessionMessage(id: string, messageId: string, content: string): Promise<SessionGoalState>;
  reorderSessionMessages(id: string, orderedIds: string[]): Promise<SessionGoalState>;
  cancelSessionMessage(id: string, messageId: string): Promise<SessionGoalState>;
  steerSessionMessage(id: string, messageId: string): Promise<SessionGoalState>;
  getThreadGoal?(id: string): Promise<ThreadGoalInfo | null>;
  setThreadGoal?(id: string, objective: string, tokenBudget?: number | null): Promise<ThreadGoalInfo>;
  updateThreadGoal?(id: string, action: "pause" | "resume"): Promise<ThreadGoalInfo>;
  clearThreadGoal?(id: string): Promise<boolean>;
  handoffSession?(id: string): Promise<unknown>;
  releaseCodexSession?(id: string): Promise<void>;
  createSession(title: string, projectId?: string, agentType?: AgentType, cwd?: string): Promise<UnifiedSessionSummary>;
  forkSession(id: string): Promise<UnifiedSessionSummary>;
  deleteSession(id: string): Promise<void>;
  refreshSessions(projectId?: string): Promise<UnifiedSessionSummary[]>;
  getRuntimeHealth(): Promise<RuntimeHealth[]>;
  listMemories(): Promise<unknown[]>;
  getMemory(name: string): Promise<unknown>;
  setMemory(entry: Record<string, unknown>): Promise<void>;
  deleteMemory(name: string): Promise<void>;
  searchMemories(query: string): Promise<unknown[]>;
  mcpList(): Promise<MCPServer[]>;
  mcpSave(server: Omit<MCPServer, 'transport'> & { transport?: string }): Promise<void>;
  mcpDelete(id: string): Promise<void>;
  mcpSetEnabled(id: string, enabled: boolean): Promise<void>;
  mcpProbe(server: MCPServer): Promise<Array<{ name: string; description: string }>>;

  listSkills(): Promise<unknown[]>;
  saveSkill(skill: Record<string, unknown>): Promise<void>;
  deleteSkill(name: string): Promise<void>;
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;
  importSkill(): Promise<{ name: string; description: string } | null>;
  listUploads(): Promise<unknown[]>;
  getUpload(id: string): Promise<unknown>;
  saveUpload(entry: Record<string, unknown>): Promise<void>;
  deleteUpload(id: string): Promise<void>;
  setProjectWorkingDir(path: string): Promise<{ ok: boolean; path: string }>;
  // Agent Definitions
  listAgentDefs(): Promise<AgentDefinition[]>;
  getAgentDef(id: string): Promise<AgentDefinition | null>;
  createAgentDef(data: Partial<AgentDefinition>): Promise<AgentDefinition>;
  updateAgentDef(id: string, update: Partial<AgentDefinition>): Promise<AgentDefinition>;
  deleteAgentDef(id: string): Promise<void>;
  setActiveAgentDef(id: string): Promise<{ activeAgentId?: string }>;
  // Cron (scheduled tasks)
  cronCreate(cron: string, prompt: string, options?: Record<string, unknown>): Promise<CronTask>;
  cronPause(id: string): Promise<CronTask | null>;
  cronResume(id: string): Promise<CronTask | null>;
  cronDelete(id: string): Promise<boolean>;
  cronDeleteAll(): Promise<{ ok: boolean }>;
  cronList(): Promise<CronTask[]>;
  // LSP Servers
  lspList(): Promise<LSPServerConfig[]>;
  lspSave(config: Omit<LSPServerConfig, 'id'> & { id?: string }): Promise<void>;
  lspDelete(id: string): Promise<void>;
  lspSetEnabled(id: string, enabled: boolean): Promise<void>;
  // AI Hub (embedded multi-AI web aggregation)
  hubGetConfig(): Promise<HubConfig>;
  hubSetConfig(raw: unknown): Promise<HubConfig>;
  hubOpenSite(siteId: string): Promise<void>;
  hubCloseSite(siteId: string): Promise<void>;
  hubHideAll(): Promise<void>;
  hubSetBounds(panes: HubPaneRect[]): Promise<void>;
  hubReload(siteId: string): Promise<void>;
  hubBroadcast(text: string, siteIds: string[], images?: string[]): Promise<HubBroadcastResult[]>;
  onHubEvent(callback: (event: HubEvent) => void): () => void;
  // AI Hub 浏览器 Profile 导入 + 托管 Google 重登录
  hubListProfileSources(): Promise<BrowserProfileSourceView[]>;
  hubImportProfile(sourceId: BrowserProfileSourceId): Promise<BrowserProfileImportResult>;
  hubGetProfileImportStatus(): Promise<BrowserProfileImportStatus>;
  hubRestartAfterProfileImport(): Promise<void>;
  hubOpenChrome(siteId: string): Promise<void>;
  hubChromeStatus(): Promise<import("../main/ai-hub/chrome-bridge-protocol").ChromeHubStatus>;
  hubChromeResume(): Promise<import("../main/ai-hub/chrome-bridge-protocol").ChromeHubStatus>;
  hubChromeConversation(siteId: string): Promise<import("../main/ai-hub/chrome-bridge-protocol").ChromeHubConversation | null>;
  hubChromeFrame(siteId: string): Promise<import("../main/ai-hub/chrome-bridge-protocol").ChromeHubFrame | null>;
  hubChromeCopyPairing(): Promise<void>;
  hubChromeInstallExtension(): Promise<{ path: string; browserOpened: boolean }>;
  hubChromeRevealExtension(): Promise<void>;
  hubChromeInput(siteId: string, input: import("../main/ai-hub/chrome-bridge-protocol").ChromeHubInput): Promise<void>;
  onHubChromeEvent(callback: (event: import("../main/ai-hub/chrome-bridge").ChromeBridgeEvent) => void): () => void;

  // Desktop live view (screen capture + remote control)
  desktopLiveSetup(): Promise<{ supported: boolean; needsSetup: boolean; status: DesktopLiveStatus }>;
  desktopLiveRecheck(): Promise<DesktopLiveStatus>;
  desktopLiveOpenPermission(permission: "screen" | "accessibility"): Promise<void>;
  desktopLiveRestart(): Promise<void>;
  desktopLiveGetStatus(): Promise<DesktopLiveStatus>;
  desktopLiveSetEnabled(enabled: boolean): Promise<DesktopLiveStatus>;
  desktopLiveGetDisplays?(): Promise<{ displays: DesktopLiveDisplayOption[] }>;
  desktopLiveSetDisplay?(displayId: string | null): Promise<{ displayId: string }>;
  onDesktopLiveStatus(callback: (status: DesktopLiveStatus) => void): () => void;

  // Global wake shortcut: fired after main has shown/focused the window
  onWakeAiHub(callback: () => void): () => void;
}

export type HubAdapterId = "deepseek" | "chatgpt" | "gemini" | "grok" | "generic";

export interface HubSite {
  id: string;
  name: string;
  url: string;
  icon?: string;
  adapter?: HubAdapterId;
}

export interface HubConfig {
  version: 1;
  sites: HubSite[];
}

export interface HubPaneRect {
  siteId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HubBroadcastResult {
  siteId: string;
  ok: boolean;
  reason?: string;
}

export interface HubEvent {
  type: "loading" | "loaded" | "load-failed" | "title" | "google-auth-external" | "google-reauth" | "profile-import";
  siteId?: string;
  errorCode?: number;
  title?: string;
  state?: GoogleReauthEventState;
  phase?: ProfileImportPhase;
}

export type GoogleReauthEventState = "started" | "synchronized" | "canceled" | "timeout" | "failed" | "unavailable";

export type ProfileImportPhase = "checking" | "copying" | "importing-cookies" | "validating" | "complete";

export type BrowserProfileSourceId = "chrome-default" | "ego-lite-default";

/** 渲染端只拿清洗后的元数据：绝不含 profilePath / Keychain 名称 */
export interface BrowserProfileSourceView {
  id: BrowserProfileSourceId;
  browserName: string;
  profileName: "Default";
  available: boolean;
  running: boolean;
  sizeBytes?: number;
  reason?: string;
}

export interface BrowserProfileImportResult {
  ok: boolean;
  sourceId: BrowserProfileSourceId;
  errorCategory?: ProfileImportErrorCategory;
  copiedBytes?: number;
  importedCookieCount?: number;
  skippedCookieCount?: number;
  completedAt?: string;
  restartRequired?: boolean;
}

export interface BrowserProfileImportStatus {
  active: boolean;
  restartRequired: boolean;
  sourceId?: string;
  completedAt?: string;
  copiedBytes?: number;
  importedCookieCount?: number;
  skippedCookieCount?: number;
  lastErrorCategory?: ProfileImportErrorCategory;
}

export type ProfileImportErrorCategory =
  | "source-unavailable"
  | "source-browser-running"
  | "keychain-denied"
  | "unsupported-profile"
  | "insufficient-disk-space"
  | "copy-failed"
  | "cookie-migration-failed"
  | "validation-failed"
  | "restart-required"
  | "chrome-unavailable"
  | "chrome-login-canceled"
  | "chrome-login-timeout"
  | "login-callback-origin-mismatch"
  | "cookie-sync-failed";

export interface GoogleReauthResult {
  status: "synchronized" | "waiting" | "canceled" | "timeout" | "failed" | "unavailable";
  reason?: string;
}

export type BrowserLiveSession = BrowserLiveSessionView;

export interface DesktopLiveStatus {
  enabled: boolean;
  permissionScreen: "granted" | "denied" | "not-determined" | "restricted" | "unknown";
  accessibilityTrusted: boolean | null;
  sessionOnline: boolean;
  controlState: LiveViewOwnershipState | null;
  error?: string;
}

export interface DesktopLiveDisplayOption {
  id: string;
  label: string;
  primary: boolean;
  selected: boolean;
}

export interface BrowserLiveApi {
  request<T = unknown>(
    method: "browser:list" | "browser:watch" | "browser:unwatch" | "browser:takeover" | "browser:return" | "browser:input" | "browser:set-display" | "browser:ping" | "browser:webrtc",
    payload?: Record<string, unknown>,
  ): Promise<T>;
  onEvent(listener: (event: Record<string, unknown> & { type: string }) => void): () => void;
}

export interface TtsStreamMetadata {
  sessionId: string;
  generation: number;
  sampleRate: 24_000;
  channels: 1;
  sampleFormat: "s16le";
}

declare global {
  interface Window {
    agentApi: AgentApi;
    browserLiveApi?: BrowserLiveApi;
  }
}
