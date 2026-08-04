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

  // Agent control
  run: (input: string, sessionId: string, agentIds?: string[], agentName?: string, images?: string[]) =>
    ipcRenderer.invoke("agent:run", input, sessionId, agentIds, agentName, images),
  steer: (input: string, sessionId: string, agentName?: string) =>
    ipcRenderer.invoke("agent:steer", input, sessionId, agentName),
  abort: () => ipcRenderer.invoke("agent:abort"),
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

  // Sessions
  listSessions: (projectId?: string) => ipcRenderer.invoke("sessions:list", projectId),
  listChildSessions: (parentId: string) => ipcRenderer.invoke("sessions:listChildren", parentId),
  getSession: (id: string) => ipcRenderer.invoke("sessions:get", id),
  createSession: (title: string, projectId?: string) => ipcRenderer.invoke("sessions:create", title, projectId),
  deleteSession: (id: string) => ipcRenderer.invoke("sessions:delete", id),

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
