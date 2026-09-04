import { contextBridge, ipcRenderer } from "electron";

// Persistent pub/sub for agent events — registered once at module load so
// listeners survive across user sends and receive cron-fired events too.
const agentEventBus = new Set<(event: unknown) => void>();
ipcRenderer.on("agent:event", (_ipcEvent, data) => {
  for (const fn of agentEventBus) fn(data);
});

contextBridge.exposeInMainWorld("agentApi", {
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
  run: (input: string, sessionId: string, agentIds?: string[], agentName?: string, images?: string[]) =>
    ipcRenderer.invoke("agent:run", input, sessionId, agentIds, agentName, images),
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
  getSession: (id: string, query?: { before?: string; limit?: number }) =>
    ipcRenderer.invoke("sessions:get", id, query),
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
});
