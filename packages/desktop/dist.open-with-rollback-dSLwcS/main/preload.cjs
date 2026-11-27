"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// Hidden WebRTC capture page signaling (desktop live real-time stream).
electron_1.contextBridge.exposeInMainWorld("webrtcLiveApi", {
    send: (message) => electron_1.ipcRenderer.send("webrtc-live:signal", message),
    onSignal: (callback) => {
        const handler = (_event, message) => callback(message);
        electron_1.ipcRenderer.on("webrtc-live:signal", handler);
        return () => electron_1.ipcRenderer.removeListener("webrtc-live:signal", handler);
    },
});
// Persistent pub/sub for agent events — registered once at module load so
// listeners survive across user sends and receive cron-fired events too.
const agentEventBus = new Set();
electron_1.ipcRenderer.on("agent:event", (_ipcEvent, data) => {
    for (const fn of agentEventBus)
        fn(data);
});
electron_1.contextBridge.exposeInMainWorld("desktopDeviceApi", {
    getUpdateStatus: () => electron_1.ipcRenderer.invoke("update:get-status"),
    checkForUpdate: () => electron_1.ipcRenderer.invoke("update:check"),
    installUpdate: () => electron_1.ipcRenderer.invoke("update:install"),
    onUpdateStatus: (callback) => {
        const handler = (_event, status) => callback(status);
        electron_1.ipcRenderer.on("update:status", handler);
        return () => electron_1.ipcRenderer.removeListener("update:status", handler);
    },
    // Window control (hide → background voice-wake mode, show → restore)
    hideWindow: () => electron_1.ipcRenderer.invoke("window:hide"),
    showWindow: () => electron_1.ipcRenderer.invoke("window:show"),
    isWindowVisible: () => electron_1.ipcRenderer.invoke("window:isVisible"),
    openNewSessionWindow: (options) => electron_1.ipcRenderer.invoke("window:new-session", options),
    openVideoWindow: (options) => electron_1.ipcRenderer.invoke("window:open-video", options),
    setNotificationVisible: (target) => electron_1.ipcRenderer.invoke("notification:visible", target),
    notificationRead: (id, scope) => electron_1.ipcRenderer.invoke("notification:read", id, scope),
    onNotificationOpen: (callback) => {
        const handler = (_event, target) => callback(target);
        electron_1.ipcRenderer.on("notification:open", handler);
        return () => electron_1.ipcRenderer.removeListener("notification:open", handler);
    },
    // 用系统浏览器打开 http(s) 链接（如 Flow Studio 免登入口）
    openExternal: (url) => electron_1.ipcRenderer.invoke("shell:open-external", url),
    notifyTaskCompletion: (notification, preferences) => electron_1.ipcRenderer.invoke("task-notification:show", notification, preferences),
    // Native wake-word listener (macOS Speech framework; works without Google services)
    wakeStart: (wakeWord) => electron_1.ipcRenderer.invoke("wake:start", wakeWord),
    wakeStop: () => electron_1.ipcRenderer.invoke("wake:stop"),
    onWake: (callback) => {
        const handler = (_e, heard) => callback(heard);
        electron_1.ipcRenderer.on("wake:trigger", handler);
        return () => electron_1.ipcRenderer.removeListener("wake:trigger", handler);
    },
    // Voice command captured right after the wake word fired
    onWakeCommand: (callback) => {
        const handler = (_e, payload) => callback(payload);
        electron_1.ipcRenderer.on("wake:command", handler);
        return () => electron_1.ipcRenderer.removeListener("wake:command", handler);
    },
    // Two-way voice conversation: follow-up utterances become commands
    // without the wake word while conversation mode is on.
    wakeConversation: (on) => electron_1.ipcRenderer.invoke("wake:conversation", on),
    // Native one-shot dictation for the chat input.
    dictationStart: () => electron_1.ipcRenderer.invoke("dictation:start"),
    dictationStop: () => electron_1.ipcRenderer.invoke("dictation:stop"),
    onDictation: (callback) => {
        const handler = (_e, payload) => callback(payload);
        electron_1.ipcRenderer.on("dictation:result", handler);
        return () => electron_1.ipcRenderer.removeListener("dictation:result", handler);
    },
    onDictationError: (callback) => {
        const handler = (_e, message) => callback(message);
        electron_1.ipcRenderer.on("dictation:error", handler);
        return () => electron_1.ipcRenderer.removeListener("dictation:error", handler);
    },
    // Agent control
    run: (input, sessionId, agentIds, agentName, images, nativeOptions) => electron_1.ipcRenderer.invoke("agent:run", input, sessionId, agentIds, agentName, images, nativeOptions),
    listAgentModels: (agentType) => electron_1.ipcRenderer.invoke("agent:list-models", agentType),
    steer: (input, sessionId, agentName) => electron_1.ipcRenderer.invoke("agent:steer", input, sessionId, agentName),
    abort: (sessionId) => electron_1.ipcRenderer.invoke("agent:abort", sessionId),
    answerQuestion: (questionId, answer, selectedIndices) => electron_1.ipcRenderer.invoke("agent:answer-question", questionId, answer, selectedIndices),
    onEvent: (callback) => {
        agentEventBus.add(callback);
        return () => agentEventBus.delete(callback);
    },
    // Settings
    getSettings: () => electron_1.ipcRenderer.invoke("settings:get"),
    saveSettings: (settings) => electron_1.ipcRenderer.invoke("settings:save", settings),
    setActiveProfile: (profileId) => electron_1.ipcRenderer.invoke("settings:setActiveProfile", profileId),
    listToolPolicies: () => electron_1.ipcRenderer.invoke("tool-policies:list"),
    saveToolPolicy: (policy, exists) => electron_1.ipcRenderer.invoke("tool-policies:save", policy, exists),
    deleteToolPolicy: (policyId) => electron_1.ipcRenderer.invoke("tool-policies:delete", policyId),
    // Projects
    listProjects: () => electron_1.ipcRenderer.invoke("projects:list"),
    getProject: (id) => electron_1.ipcRenderer.invoke("projects:get", id),
    createProject: (name, description) => electron_1.ipcRenderer.invoke("projects:create", { name, description }),
    updateProject: (id, update) => electron_1.ipcRenderer.invoke("projects:update", id, update),
    deleteProject: (id) => electron_1.ipcRenderer.invoke("projects:delete", id),
    checkProjectPath: (path) => electron_1.ipcRenderer.invoke("projects:checkPath", path),
    listProjectRoots: async () => [],
    getProjectPickerLocation: async () => ({ roots: [], initialPath: "" }),
    listProjectDirectories: async (_path) => [],
    // Sessions
    listSessions: (projectId) => electron_1.ipcRenderer.invoke("sessions:list", projectId),
    listAgentWorkspaces: (agentType, query) => electron_1.ipcRenderer.invoke("workspaces:list", agentType, query),
    importAgentWorkspace: (agentType, path, name) => electron_1.ipcRenderer.invoke("workspaces:import", agentType, path, name),
    listAgentWorkspaceSessions: (agentType, workspaceId, query) => electron_1.ipcRenderer.invoke("workspaces:listSessions", agentType, workspaceId, query),
    listChildSessions: (parentId) => electron_1.ipcRenderer.invoke("sessions:listChildren", parentId),
    getSession: (id, query) => electron_1.ipcRenderer.invoke("sessions:get", id, query),
    getSessionToolResult: (id, ref) => electron_1.ipcRenderer.invoke("sessions:getToolResult", id, ref),
    getSessionQueryIndex: (id) => electron_1.ipcRenderer.invoke("sessions:getQueryIndex", id),
    setSessionPermissionMode: (id, mode) => electron_1.ipcRenderer.invoke("sessions:setPermissionMode", id, mode),
    getSessionGoals: (id) => electron_1.ipcRenderer.invoke("sessions:getGoals", id),
    enqueueSessionGoal: (id, objective, sourceMessageId) => electron_1.ipcRenderer.invoke("sessions:enqueueGoal", id, objective, sourceMessageId),
    reorderSessionGoals: (id, orderedIds) => electron_1.ipcRenderer.invoke("sessions:reorderGoals", id, orderedIds),
    cancelSessionGoal: (id, goalId) => electron_1.ipcRenderer.invoke("sessions:cancelGoal", id, goalId),
    enqueueSessionMessage: (id, message) => electron_1.ipcRenderer.invoke("sessions:enqueueMessage", id, message),
    updateSessionMessage: (id, messageId, content) => electron_1.ipcRenderer.invoke("sessions:updateMessage", id, messageId, content),
    reorderSessionMessages: (id, orderedIds) => electron_1.ipcRenderer.invoke("sessions:reorderMessages", id, orderedIds),
    cancelSessionMessage: (id, messageId) => electron_1.ipcRenderer.invoke("sessions:cancelMessage", id, messageId),
    steerSessionMessage: (id, messageId) => electron_1.ipcRenderer.invoke("sessions:steerMessage", id, messageId),
    handoffSession: (id) => electron_1.ipcRenderer.invoke("sessions:handoff", id),
    releaseCodexSession: (id) => electron_1.ipcRenderer.invoke("sessions:releaseCodex", id),
    createSession: (title, projectId, agentType = "customer-agent", cwd) => electron_1.ipcRenderer.invoke("sessions:create", title, projectId, agentType, cwd),
    forkSession: (id) => electron_1.ipcRenderer.invoke("sessions:fork", id),
    deleteSession: (id) => electron_1.ipcRenderer.invoke("sessions:delete", id),
    refreshSessions: (projectId) => electron_1.ipcRenderer.invoke("sessions:refresh", projectId),
    getRuntimeHealth: () => electron_1.ipcRenderer.invoke("sessions:runtimeHealth"),
    // Memory
    listMemories: () => electron_1.ipcRenderer.invoke("memory:list"),
    getMemory: (name) => electron_1.ipcRenderer.invoke("memory:get", name),
    setMemory: (entry) => electron_1.ipcRenderer.invoke("memory:set", entry),
    deleteMemory: (name) => electron_1.ipcRenderer.invoke("memory:delete", name),
    searchMemories: (query) => electron_1.ipcRenderer.invoke("memory:search", query),
    // MCP Servers
    mcpList: () => electron_1.ipcRenderer.invoke("mcp:list"),
    mcpSave: (server) => electron_1.ipcRenderer.invoke("mcp:save", server),
    mcpDelete: (id) => electron_1.ipcRenderer.invoke("mcp:delete", id),
    mcpSetEnabled: (id, enabled) => electron_1.ipcRenderer.invoke("mcp:setEnabled", id, enabled),
    mcpProbe: (server) => electron_1.ipcRenderer.invoke("mcp:probe", server),
    // LSP Servers
    lspList: () => electron_1.ipcRenderer.invoke("lsp:list"),
    lspSave: (config) => electron_1.ipcRenderer.invoke("lsp:save", config),
    lspDelete: (id) => electron_1.ipcRenderer.invoke("lsp:delete", id),
    lspSetEnabled: (id, enabled) => electron_1.ipcRenderer.invoke("lsp:setEnabled", id, enabled),
    // Skills
    listSkills: () => electron_1.ipcRenderer.invoke("skills:list"),
    saveSkill: (skill) => electron_1.ipcRenderer.invoke("skills:save", skill),
    deleteSkill: (name) => electron_1.ipcRenderer.invoke("skills:delete", name),
    setSkillEnabled: (name, enabled) => electron_1.ipcRenderer.invoke("skills:set-enabled", name, enabled),
    importSkill: () => electron_1.ipcRenderer.invoke("skills:import"),
    // Upload
    listUploads: () => electron_1.ipcRenderer.invoke("upload:list"),
    getUpload: (id) => electron_1.ipcRenderer.invoke("upload:get", id),
    saveUpload: (entry) => electron_1.ipcRenderer.invoke("upload:save", entry),
    deleteUpload: (id) => electron_1.ipcRenderer.invoke("upload:delete", id),
    // File operations
    openFileDialog: () => electron_1.ipcRenderer.invoke("file:dialog:open"),
    showDirectoryContextMenu: (path) => electron_1.ipcRenderer.invoke("directory:show-context-menu", path),
    showFileContextMenu: (path, options) => options === undefined
        ? electron_1.ipcRenderer.invoke("file:show-context-menu", path)
        : electron_1.ipcRenderer.invoke("file:show-context-menu", path, options),
    artifactFileAction: (path, action) => electron_1.ipcRenderer.invoke("file:artifact-action", path, action),
    fileWorkspaceRequest: (method, params) => electron_1.ipcRenderer.invoke("file-workspace:request", method, params),
    onFileWorkspaceEvent: (callback) => {
        const handler = (_event, payload) => callback(payload);
        electron_1.ipcRenderer.on("file-workspace:event", handler);
        return () => electron_1.ipcRenderer.removeListener("file-workspace:event", handler);
    },
    readFile: (path) => electron_1.ipcRenderer.invoke("file:read", path),
    writeFile: (path, content) => electron_1.ipcRenderer.invoke("file:write", path, content),
    setProjectWorkingDir: (path) => electron_1.ipcRenderer.invoke("project:set-working-dir", path),
    // Agent Definitions
    listAgentDefs: () => electron_1.ipcRenderer.invoke("agentdef:list"),
    getAgentDef: (id) => electron_1.ipcRenderer.invoke("agentdef:get", id),
    createAgentDef: (data) => electron_1.ipcRenderer.invoke("agentdef:create", data),
    updateAgentDef: (id, update) => electron_1.ipcRenderer.invoke("agentdef:update", id, update),
    deleteAgentDef: (id) => electron_1.ipcRenderer.invoke("agentdef:delete", id),
    setActiveAgentDef: (id) => electron_1.ipcRenderer.invoke("agentdef:setActive", id),
    // Cron (scheduled tasks)
    cronCreate: (cron, prompt, options) => electron_1.ipcRenderer.invoke("cron:create", cron, prompt, options),
    cronPause: (id) => electron_1.ipcRenderer.invoke("cron:pause", id),
    cronResume: (id) => electron_1.ipcRenderer.invoke("cron:resume", id),
    cronDelete: (id) => electron_1.ipcRenderer.invoke("cron:delete", id),
    cronDeleteAll: () => electron_1.ipcRenderer.invoke("cron:delete-all"),
    cronList: () => electron_1.ipcRenderer.invoke("cron:list"),
    // AI Hub (embedded multi-AI web aggregation)
    hubGetConfig: () => electron_1.ipcRenderer.invoke("hub:get-config"),
    hubSetConfig: (raw) => electron_1.ipcRenderer.invoke("hub:set-config", raw),
    hubOpenSite: (siteId, conversationId) => electron_1.ipcRenderer.invoke("hub:open", siteId, conversationId),
    hubCloseSite: (siteId, conversationId) => electron_1.ipcRenderer.invoke("hub:close", siteId, conversationId),
    hubHideAll: () => electron_1.ipcRenderer.invoke("hub:hide-all"),
    hubSetBounds: (panes) => electron_1.ipcRenderer.invoke("hub:set-bounds", panes),
    hubReload: (siteId, conversationId) => electron_1.ipcRenderer.invoke("hub:reload", siteId, conversationId),
    hubBroadcast: (text, siteIds, images = []) => electron_1.ipcRenderer.invoke("hub:broadcast", text, siteIds, images),
    onHubEvent: (callback) => {
        const handler = (_event, data) => callback(data);
        electron_1.ipcRenderer.on("hub:event", handler);
        return () => electron_1.ipcRenderer.removeListener("hub:event", handler);
    },
    // Flow Studio reuses the native AI Hub embedding path without becoming a Hub site.
    flowStudioOpen: (url) => electron_1.ipcRenderer.invoke("flow-studio:open", url),
    flowStudioSetBounds: (rect) => electron_1.ipcRenderer.invoke("flow-studio:set-bounds", rect),
    flowStudioReload: () => electron_1.ipcRenderer.invoke("flow-studio:reload"),
    taskPageOpen: (paneId, url) => electron_1.ipcRenderer.invoke("task-page:open", paneId, url),
    taskPageSetBounds: (paneId, rect) => electron_1.ipcRenderer.invoke("task-page:set-bounds", paneId, rect),
    taskPageReload: (paneId) => electron_1.ipcRenderer.invoke("task-page:reload", paneId),
    taskPageClose: (paneId) => electron_1.ipcRenderer.invoke("task-page:close", paneId),
    onFlowStudioEvent: (callback) => {
        const handler = (_event, data) => callback(data);
        electron_1.ipcRenderer.on("flow-studio:event", handler);
        return () => electron_1.ipcRenderer.removeListener("flow-studio:event", handler);
    },
    // AI Hub 浏览器 Profile 导入 + 托管 Google 重登录（只传固定来源 id，不传路径）
    hubListProfileSources: () => electron_1.ipcRenderer.invoke("hub:list-profile-sources"),
    hubImportProfile: (sourceId) => electron_1.ipcRenderer.invoke("hub:import-profile", sourceId),
    hubGetProfileImportStatus: () => electron_1.ipcRenderer.invoke("hub:get-profile-import-status"),
    hubRestartAfterProfileImport: () => electron_1.ipcRenderer.invoke("hub:restart-after-profile-import"),
    hubOpenChrome: (siteId) => electron_1.ipcRenderer.invoke("hub:open-chrome", siteId),
    hubChromeStatus: () => electron_1.ipcRenderer.invoke("hub:chrome-status"),
    hubChromeResume: () => electron_1.ipcRenderer.invoke("hub:chrome-resume"),
    hubChromeConversation: (siteId) => electron_1.ipcRenderer.invoke("hub:chrome-conversation", siteId),
    hubChromeFrame: (siteId) => electron_1.ipcRenderer.invoke("hub:chrome-frame", siteId),
    hubChromeCopyPairing: () => electron_1.ipcRenderer.invoke("hub:chrome-copy-pairing"),
    hubChromeInstallExtension: () => electron_1.ipcRenderer.invoke("hub:chrome-install-extension"),
    hubChromeRevealExtension: () => electron_1.ipcRenderer.invoke("hub:chrome-reveal-extension"),
    hubChromeInput: (siteId, input) => electron_1.ipcRenderer.invoke("hub:chrome-input", siteId, input),
    onHubChromeEvent: (callback) => {
        const listener = (_event, event) => callback(event);
        electron_1.ipcRenderer.on("hub:chrome-event", listener);
        return () => electron_1.ipcRenderer.removeListener("hub:chrome-event", listener);
    },
    // Desktop live view (screen capture + remote control)
    desktopLiveSetup: () => electron_1.ipcRenderer.invoke("desktop-live:setup"),
    desktopLiveRecheck: () => electron_1.ipcRenderer.invoke("desktop-live:recheck"),
    desktopLiveOpenPermission: (permission) => electron_1.ipcRenderer.invoke("desktop-live:open-permission", permission),
    desktopLiveRestart: () => electron_1.ipcRenderer.invoke("desktop-live:restart"),
    desktopLiveGetStatus: () => electron_1.ipcRenderer.invoke("desktop-live:get-status"),
    desktopLiveSetEnabled: (enabled) => electron_1.ipcRenderer.invoke("desktop-live:set-enabled", enabled),
    desktopLiveGetDisplays: () => electron_1.ipcRenderer.invoke("desktop-live:get-displays"),
    desktopLiveSetDisplay: (displayId) => electron_1.ipcRenderer.invoke("desktop-live:set-display", displayId),
    onDesktopLiveStatus: (callback) => {
        const handler = (_event, status) => callback(status);
        electron_1.ipcRenderer.on("desktop-live:status", handler);
        return () => electron_1.ipcRenderer.removeListener("desktop-live:status", handler);
    },
    // Global wake shortcut: main has already shown/focused the window
    onWakeAiHub: (callback) => {
        const handler = () => callback();
        electron_1.ipcRenderer.on("app:wake-aihub", handler);
        return () => electron_1.ipcRenderer.removeListener("app:wake-aihub", handler);
    },
});
// Fixed transport capability; credentials and service discovery stay in main.
electron_1.contextBridge.exposeInMainWorld("sharedServiceApi", {
    status: () => electron_1.ipcRenderer.invoke("service:status"),
    mobilePairing: () => electron_1.ipcRenderer.invoke("service:mobile-pairing"),
    tunnelStatus: () => electron_1.ipcRenderer.invoke("service:tunnel-status"),
    connectTunnel: () => electron_1.ipcRenderer.invoke("service:tunnel-connect"),
    bootstrapStatus: () => electron_1.ipcRenderer.invoke("service:bootstrap-status"),
    prepareRuntime: () => electron_1.ipcRenderer.invoke("service:bootstrap"),
    select: (id) => electron_1.ipcRenderer.invoke("service:select", id),
    request: (path, method, body) => electron_1.ipcRenderer.invoke("service:request", path, method, body),
    stream: (id, path, lastEventId) => electron_1.ipcRenderer.invoke("service:stream", id, path, lastEventId),
    stop: (id) => electron_1.ipcRenderer.invoke("service:stream-stop", id),
    terminalSocket: {
        open: (id) => electron_1.ipcRenderer.invoke("service:terminal-open", id),
        send: (id, data) => electron_1.ipcRenderer.invoke("service:terminal-send", id, data),
        close: (id) => electron_1.ipcRenderer.invoke("service:terminal-stop", id),
        onFrame: (callback) => {
            const listener = (_event, frame) => callback(frame);
            electron_1.ipcRenderer.on("service:terminal-frame", listener);
            return () => electron_1.ipcRenderer.removeListener("service:terminal-frame", listener);
        },
    },
    onFrame: (callback) => {
        const listener = (_event, frame) => callback(frame);
        electron_1.ipcRenderer.on("service:stream-frame", listener);
        return () => electron_1.ipcRenderer.removeListener("service:stream-frame", listener);
    },
});
// Renderer-side global errors are reported into the main process's daily
// log file (see client-log:report in main/index.ts).
electron_1.contextBridge.exposeInMainWorld("clientLogApi", {
    report: (payload) => electron_1.ipcRenderer.invoke("client-log:report", payload),
});
