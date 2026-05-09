import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentApi", {
  // Agent control
  run: (input: string, sessionId: string, agentIds?: string[], agentName?: string) =>
    ipcRenderer.invoke("agent:run", input, sessionId, agentIds, agentName),
  abort: () => ipcRenderer.invoke("agent:abort"),
  onEvent: (callback: (event: unknown) => void) => {
    ipcRenderer.removeAllListeners("agent:event");
    ipcRenderer.on("agent:event", (_event, data) => callback(data));
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

  // Sessions
  listSessions: (projectId?: string) => ipcRenderer.invoke("sessions:list", projectId),
  getSession: (id: string) => ipcRenderer.invoke("sessions:get", id),
  createSession: (title: string, projectId?: string) => ipcRenderer.invoke("sessions:create", title, projectId),
  deleteSession: (id: string) => ipcRenderer.invoke("sessions:delete", id),

  // Memory
  listMemories: () => ipcRenderer.invoke("memory:list"),
  getMemory: (name: string) => ipcRenderer.invoke("memory:get", name),
  setMemory: (entry: Record<string, unknown>) => ipcRenderer.invoke("memory:set", entry),
  deleteMemory: (name: string) => ipcRenderer.invoke("memory:delete", name),
  searchMemories: (query: string) => ipcRenderer.invoke("memory:search", query),

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
});
