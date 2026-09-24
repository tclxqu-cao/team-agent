import { contextBridge, ipcRenderer } from "electron";

// Hidden WebRTC capture page signaling (desktop live real-time stream).
contextBridge.exposeInMainWorld("webrtcLiveApi", {
  send: (message: unknown) => ipcRenderer.send("webrtc-live:signal", message),
  onSignal: (callback: (message: unknown) => void): (() => void) => {
    const handler = (_event: unknown, message: unknown) => callback(message);
    ipcRenderer.on("webrtc-live:signal", handler);
    return () => ipcRenderer.removeListener("webrtc-live:signal", handler);
  },
});

// Persistent pub/sub for agent events — registered once at module load so
// listeners survive across user sends and receive cron-fired events too.
const agentEventBus = new Set<(event: unknown) => void>();
ipcRenderer.on("agent:event", (_ipcEvent, data) => {
  for (const fn of agentEventBus) fn(data);
});

contextBridge.exposeInMainWorld("desktopDeviceApi", {
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateStatus: (callback: (status: unknown) => void): (() => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
  // Window control (hide → background voice-wake mode, show → restore)
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  showWindow: () => ipcRenderer.invoke("window:show"),
  isWindowVisible: () => ipcRenderer.invoke("window:isVisible"),

  // Native wake-word listener (macOS Speech framework; works without Google services)
  wakeStart: (wakeWord: string) => ipcRenderer.invoke("wake:start", wakeWord),
  wakeStop: () => ipcRenderer.invoke("wake:stop"),
  onWake: (callback: (heard: string) => void): (() => void) => {
    const handler = (_e: unknown, heard: string) => callback(heard);
    ipcRenderer.on("wake:trigger", handler);
    return () => ipcRenderer.removeListener("wake:trigger", handler);
  },
  // Voice command captured right after the wake word fired
  onWakeCommand: (callback: (payload: { text: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { text: string }) => callback(payload);
    ipcRenderer.on("wake:command", handler);
    return () => ipcRenderer.removeListener("wake:command", handler);
  },
  // Two-way voice conversation: follow-up utterances become commands
  // without the wake word while conversation mode is on.
  wakeConversation: (on: boolean) => ipcRenderer.invoke("wake:conversation", on),

  // Native one-shot dictation for the chat input.
  dictationStart: () => ipcRenderer.invoke("dictation:start"),
  dictationStop: () => ipcRenderer.invoke("dictation:stop"),
  onDictation: (callback: (payload: { text: string; isFinal: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { text: string; isFinal: boolean }) => callback(payload);
    ipcRenderer.on("dictation:result", handler);
    return () => ipcRenderer.removeListener("dictation:result", handler);
  },
  onDictationError: (callback: (message: string) => void): (() => void) => {
    const handler = (_e: unknown, message: string) => callback(message);
    ipcRenderer.on("dictation:error", handler);
    return () => ipcRenderer.removeListener("dictation:error", handler);
  },

  // Model-backed TTS via the voice service
  ttsSpeak: (text: string) => ipcRenderer.invoke("tts:speak", text),
  ttsStop: () => ipcRenderer.invoke("tts:stop"),
  ttsPlaybackEnded: (generation: number) => ipcRenderer.invoke("tts:playback-ended", generation),
  onTtsStart: (callback: (payload: unknown) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("tts:start", handler);
    return () => ipcRenderer.removeListener("tts:start", handler);
  },
  onTtsPcm: (callback: (payload: unknown) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("tts:pcm", handler);
    return () => ipcRenderer.removeListener("tts:pcm", handler);
  },
  onTtsStreamEnd: (callback: (payload: unknown) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("tts:stream-end", handler);
    return () => ipcRenderer.removeListener("tts:stream-end", handler);
  },
  onTtsFlush: (callback: (payload: unknown) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("tts:flush", handler);
    return () => ipcRenderer.removeListener("tts:flush", handler);
  },
  onTtsEnd: (callback: (payload: unknown) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("tts:end", handler);
    return () => ipcRenderer.removeListener("tts:end", handler);
  },

  // Agent control
  run: (input: string, sessionId: string, agentIds?: string[], agentName?: string, images?: string[], nativeOptions?: unknown) =>
    ipcRenderer.invoke("agent:run", input, sessionId, agentIds, agentName, images, nativeOptions),
  listAgentModels: (agentType: string) => ipcRenderer.invoke("agent:list-models", agentType),
  steer: (input: string, sessionId: string, agentName?: string) =>
    ipcRenderer.invoke("agent:steer", input, sessionId, agentName),
  abort: (sessionId?: string) => ipcRenderer.invoke("agent:abort", sessionId),
  answerQuestion: (questionId: string, answer: string, selectedIndices?: number[]) =>
    ipcRenderer.invoke("agent:answer-question", questionId, answer, selectedIndices),
  onEvent: (callback: (event: unknown) => void): (() => void) => {
    agentEventBus.add(callback);
    return () => agentEventBus.delete(callback);
  },

  // Settings
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: Record<string, unknown>) => ipcRenderer.invoke("settings:save", settings),
  setActiveProfile: (profileId: string) => ipcRenderer.invoke("settings:setActiveProfile", profileId),

  // Projects
  listProjects: () => ipcRenderer.invoke("projects:list"),
  getProject: (id: string) => ipcRenderer.invoke("projects:get", id),
  createProject: (name: string, description?: string) => ipcRenderer.invoke("projects:create", { name, description }),
  updateProject: (id: string, update: Record<string, unknown>) => ipcRenderer.invoke("projects:update", id, update),
  deleteProject: (id: string) => ipcRenderer.invoke("projects:delete", id),
  checkProjectPath: (path: string) => ipcRenderer.invoke("projects:checkPath", path),
  listProjectRoots: async () => [],
  listProjectDirectories: async (_path: string) => [],

  // Sessions
  listSessions: (projectId?: string) => ipcRenderer.invoke("sessions:list", projectId),
  listAgentWorkspaces: (agentType: string, query?: Record<string, unknown>) =>
    ipcRenderer.invoke("workspaces:list", agentType, query),
  importAgentWorkspace: (agentType: string, path: string, name?: string) =>
    ipcRenderer.invoke("workspaces:import", agentType, path, name),
  listAgentWorkspaceSessions: (agentType: string, workspaceId: string, query?: Record<string, unknown>) =>
    ipcRenderer.invoke("workspaces:listSessions", agentType, workspaceId, query),
  listChildSessions: (parentId: string) => ipcRenderer.invoke("sessions:listChildren", parentId),
  getSession: (id: string, query?: { before?: string; after?: string; anchor?: string; limit?: number; view?: "core" | "trace"; revision?: string; turnId?: string }) =>
    ipcRenderer.invoke("sessions:get", id, query),
  getSessionToolResult: (id: string, ref: { turnId: string; itemId: string; revision: string }) =>
    ipcRenderer.invoke("sessions:getToolResult", id, ref),
  getSessionQueryIndex: (id: string) => ipcRenderer.invoke("sessions:getQueryIndex", id),
  setSessionPermissionMode: (id: string, mode: "request-approval" | "auto-approval" | "full-access") =>
    ipcRenderer.invoke("sessions:setPermissionMode", id, mode),
  getSessionGoals: (id: string) => ipcRenderer.invoke("sessions:getGoals", id),
  enqueueSessionGoal: (id: string, objective: string, sourceMessageId?: string) =>
    ipcRenderer.invoke("sessions:enqueueGoal", id, objective, sourceMessageId),
  reorderSessionGoals: (id: string, orderedIds: string[]) =>
    ipcRenderer.invoke("sessions:reorderGoals", id, orderedIds),
  cancelSessionGoal: (id: string, goalId: string) =>
    ipcRenderer.invoke("sessions:cancelGoal", id, goalId),
  enqueueSessionMessage: (
    id: string,
    message: { sourceMessageId: string; content: string; images?: string[]; agentIds?: string[]; agentName?: string },
  ) => ipcRenderer.invoke("sessions:enqueueMessage", id, message),
  updateSessionMessage: (id: string, messageId: string, content: string) =>
    ipcRenderer.invoke("sessions:updateMessage", id, messageId, content),
  reorderSessionMessages: (id: string, orderedIds: string[]) =>
    ipcRenderer.invoke("sessions:reorderMessages", id, orderedIds),
  cancelSessionMessage: (id: string, messageId: string) =>
    ipcRenderer.invoke("sessions:cancelMessage", id, messageId),
  steerSessionMessage: (id: string, messageId: string) =>
    ipcRenderer.invoke("sessions:steerMessage", id, messageId),
  handoffSession: (id: string) => ipcRenderer.invoke("sessions:handoff", id),
  releaseCodexSession: (id: string) => ipcRenderer.invoke("sessions:releaseCodex", id),
  createSession: (title: string, projectId?: string, agentType = "customer-agent", cwd?: string) =>
    ipcRenderer.invoke("sessions:create", title, projectId, agentType, cwd),
  forkSession: (id: string) => ipcRenderer.invoke("sessions:fork", id),
  deleteSession: (id: string) => ipcRenderer.invoke("sessions:delete", id),
  refreshSessions: (projectId?: string) => ipcRenderer.invoke("sessions:refresh", projectId),
  getRuntimeHealth: () => ipcRenderer.invoke("sessions:runtimeHealth"),

  // Memory
  listMemories: () => ipcRenderer.invoke("memory:list"),
  getMemory: (name: string) => ipcRenderer.invoke("memory:get", name),
  setMemory: (entry: Record<string, unknown>) => ipcRenderer.invoke("memory:set", entry),
  deleteMemory: (name: string) => ipcRenderer.invoke("memory:delete", name),
  searchMemories: (query: string) => ipcRenderer.invoke("memory:search", query),

  // MCP Servers
  mcpList: () => ipcRenderer.invoke("mcp:list"),
  mcpSave: (server: Record<string, unknown>) => ipcRenderer.invoke("mcp:save", server),
  mcpDelete: (id: string) => ipcRenderer.invoke("mcp:delete", id),
  mcpSetEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("mcp:setEnabled", id, enabled),
  mcpProbe: (server: Record<string, unknown>) => ipcRenderer.invoke("mcp:probe", server),

  // LSP Servers
  lspList: () => ipcRenderer.invoke("lsp:list"),
  lspSave: (config: Record<string, unknown>) => ipcRenderer.invoke("lsp:save", config),
  lspDelete: (id: string) => ipcRenderer.invoke("lsp:delete", id),
  lspSetEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("lsp:setEnabled", id, enabled),

  // Skills
  listSkills: () => ipcRenderer.invoke("skills:list"),
  saveSkill: (skill: Record<string, unknown>) => ipcRenderer.invoke("skills:save", skill),
  deleteSkill: (name: string) => ipcRenderer.invoke("skills:delete", name),
  setSkillEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke("skills:set-enabled", name, enabled),
  importSkill: () => ipcRenderer.invoke("skills:import"),

  // Upload
  listUploads: () => ipcRenderer.invoke("upload:list"),
  getUpload: (id: string) => ipcRenderer.invoke("upload:get", id),
  saveUpload: (entry: Record<string, unknown>) => ipcRenderer.invoke("upload:save", entry),
  deleteUpload: (id: string) => ipcRenderer.invoke("upload:delete", id),

  // File operations
  openFileDialog: () => ipcRenderer.invoke("file:dialog:open"),
  showDirectoryContextMenu: (path: string) => ipcRenderer.invoke("directory:show-context-menu", path),
  fileWorkspaceRequest: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke("file-workspace:request", method, params),
  onFileWorkspaceEvent: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("file-workspace:event", handler);
    return () => ipcRenderer.removeListener("file-workspace:event", handler);
  },
  readFile: (path: string) => ipcRenderer.invoke("file:read", path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke("file:write", path, content),
  setProjectWorkingDir: (path: string) => ipcRenderer.invoke("project:set-working-dir", path),

  // Agent Definitions
  listAgentDefs: () => ipcRenderer.invoke("agentdef:list"),
  getAgentDef: (id: string) => ipcRenderer.invoke("agentdef:get", id),
  createAgentDef: (data: Record<string, unknown>) => ipcRenderer.invoke("agentdef:create", data),
  updateAgentDef: (id: string, update: Record<string, unknown>) => ipcRenderer.invoke("agentdef:update", id, update),
  deleteAgentDef: (id: string) => ipcRenderer.invoke("agentdef:delete", id),
  setActiveAgentDef: (id: string) => ipcRenderer.invoke("agentdef:setActive", id),

  // Cron (scheduled tasks)
  cronCreate: (cron: string, prompt: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke("cron:create", cron, prompt, options),
  cronPause: (id: string) => ipcRenderer.invoke("cron:pause", id),
  cronResume: (id: string) => ipcRenderer.invoke("cron:resume", id),
  cronDelete: (id: string) => ipcRenderer.invoke("cron:delete", id),
  cronDeleteAll: () => ipcRenderer.invoke("cron:delete-all"),
  cronList: () => ipcRenderer.invoke("cron:list"),

  // AI Hub (embedded multi-AI web aggregation)
  hubGetConfig: () => ipcRenderer.invoke("hub:get-config"),
  hubSetConfig: (raw: unknown) => ipcRenderer.invoke("hub:set-config", raw),
  hubOpenSite: (siteId: string, conversationId?: string) => ipcRenderer.invoke("hub:open", siteId, conversationId),
  hubCloseSite: (siteId: string, conversationId?: string) => ipcRenderer.invoke("hub:close", siteId, conversationId),
  hubHideAll: () => ipcRenderer.invoke("hub:hide-all"),
  hubSetBounds: (panes: Array<{ siteId: string; conversationId?: string; x: number; y: number; width: number; height: number }>) =>
    ipcRenderer.invoke("hub:set-bounds", panes),
  hubReload: (siteId: string, conversationId?: string) => ipcRenderer.invoke("hub:reload", siteId, conversationId),
  hubBroadcast: (text: string, siteIds: string[], images: string[] = []) => ipcRenderer.invoke("hub:broadcast", text, siteIds, images),
  onHubEvent: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("hub:event", handler);
    return () => ipcRenderer.removeListener("hub:event", handler);
  },

  // AI Hub 浏览器 Profile 导入 + 托管 Google 重登录（只传固定来源 id，不传路径）
  hubListProfileSources: () => ipcRenderer.invoke("hub:list-profile-sources"),
  hubImportProfile: (sourceId: string) => ipcRenderer.invoke("hub:import-profile", sourceId),
  hubGetProfileImportStatus: () => ipcRenderer.invoke("hub:get-profile-import-status"),
  hubRestartAfterProfileImport: () => ipcRenderer.invoke("hub:restart-after-profile-import"),
  hubOpenChrome: (siteId: string) => ipcRenderer.invoke("hub:open-chrome", siteId),
  hubChromeStatus: () => ipcRenderer.invoke("hub:chrome-status"),
  hubChromeResume: () => ipcRenderer.invoke("hub:chrome-resume"),
  hubChromeConversation: (siteId: string) => ipcRenderer.invoke("hub:chrome-conversation", siteId),
  hubChromeFrame: (siteId: string) => ipcRenderer.invoke("hub:chrome-frame", siteId),
  hubChromeCopyPairing: () => ipcRenderer.invoke("hub:chrome-copy-pairing"),
  hubChromeInstallExtension: () => ipcRenderer.invoke("hub:chrome-install-extension"),
  hubChromeRevealExtension: () => ipcRenderer.invoke("hub:chrome-reveal-extension"),
  hubChromeInput: (siteId: string, input: unknown) => ipcRenderer.invoke("hub:chrome-input", siteId, input),
  onHubChromeEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: unknown) => callback(event);
    ipcRenderer.on("hub:chrome-event", listener);
    return () => ipcRenderer.removeListener("hub:chrome-event", listener);
  },

  // Desktop live view (screen capture + remote control)
  desktopLiveSetup: () => ipcRenderer.invoke("desktop-live:setup"),
  desktopLiveRecheck: () => ipcRenderer.invoke("desktop-live:recheck"),
  desktopLiveOpenPermission: (permission: "screen" | "accessibility") => ipcRenderer.invoke("desktop-live:open-permission", permission),
  desktopLiveRestart: () => ipcRenderer.invoke("desktop-live:restart"),
  desktopLiveGetStatus: () => ipcRenderer.invoke("desktop-live:get-status"),
  desktopLiveSetEnabled: (enabled: boolean) => ipcRenderer.invoke("desktop-live:set-enabled", enabled),
  desktopLiveGetDisplays: () => ipcRenderer.invoke("desktop-live:get-displays"),
  desktopLiveSetDisplay: (displayId: string | null) => ipcRenderer.invoke("desktop-live:set-display", displayId),
  onDesktopLiveStatus: (callback: (status: unknown) => void): (() => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on("desktop-live:status", handler);
    return () => ipcRenderer.removeListener("desktop-live:status", handler);
  },

  // Global wake shortcut: main has already shown/focused the window
  onWakeAiHub: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on("app:wake-aihub", handler);
    return () => ipcRenderer.removeListener("app:wake-aihub", handler);
  },
});

// Fixed transport capability; credentials and service discovery stay in main.
contextBridge.exposeInMainWorld("sharedServiceApi", {
  status: () => ipcRenderer.invoke("service:status"),
  select: (id: string) => ipcRenderer.invoke("service:select", id),
  request: (path: string, method: string, body?: string) => ipcRenderer.invoke("service:request", path, method, body),
  stream: (id: string, path: string, lastEventId: string) => ipcRenderer.invoke("service:stream", id, path, lastEventId),
  stop: (id: string) => ipcRenderer.invoke("service:stream-stop", id),
  onFrame: (callback: (frame: unknown) => void) => {
    const listener = (_event: unknown, frame: unknown) => callback(frame);
    ipcRenderer.on("service:stream-frame", listener);
    return () => ipcRenderer.removeListener("service:stream-frame", listener);
  },
});

// Renderer-side global errors are reported into the main process's daily
// log file (see client-log:report in main/index.ts).
contextBridge.exposeInMainWorld("clientLogApi", {
  report: (payload: unknown) => ipcRenderer.invoke("client-log:report", payload),
});
