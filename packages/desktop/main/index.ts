import { app, BrowserWindow, ipcMain, dialog, session } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { AgentHost } from "./agent-host.js";

// Suppress EPIPE errors on stdout/stderr (e.g., when output is piped to `head`)
// Without this, broken pipes cause an uncaught exception that crashes the main process.
process.stdout.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") throw err; });
process.stderr.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") throw err; });

// ── Single-instance lock ──────────────────────────────────────────────────
// Electron uses an OS-level lock tied to the app's userData directory.
// If a second instance starts, it focuses the existing window and quits.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
let mainWindow: BrowserWindow | null = null;
const agentHost = new AgentHost(process.cwd());

// Forward ALL agent events (including cron-fired runs) to the renderer.
// This covers both user-initiated runs and background cron queue drains.
agentHost.subscribe((event) => {
  mainWindow?.webContents.send("agent:event", event);
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    titleBarStyle: "hiddenInset",
    title: "Customer Agent",
  });

  const port = process.env.VITE_PORT ?? "5173";
  const isDev = process.env.NODE_ENV !== "production" && !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, "../../renderer-dist/index.html"));
  }
}

// ── IPC: Window control (hide/restore for voice-wake background mode) ──

ipcMain.handle("window:hide", () => {
  // Hide instead of close so the renderer keeps running (voice wake loop).
  mainWindow?.hide();
  return { ok: true };
});

ipcMain.handle("window:show", () => {
  if (mainWindow) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  return { ok: true };
});

ipcMain.handle("window:isVisible", () => {
  return mainWindow?.isVisible() ?? false;
});

// ── IPC: Agent control ──

ipcMain.handle("agent:run", async (_event, input: string, sessionId: string, agentIds?: string[], agentName?: string, images?: string[]) => {
  agentHost.setRunning(true);
  try {
    for await (const _event of agentHost.run(input, sessionId, agentIds, agentName, images)) {
      // events are forwarded to renderer via the global subscriber above
    }
  } catch (err) {
    mainWindow?.webContents.send("agent:event", {
      type: "error",
      message: err instanceof Error ? err.message : "Unknown error",
    });
  } finally {
    agentHost.setRunning(false);
  }
});

ipcMain.handle("agent:abort", () => {
  agentHost.abort();
});

// Resolve a pending ask_user question with the user's answer
ipcMain.handle("agent:answer-question", (_event, questionId: string, answer: string, selectedIndices?: number[]) => {
  return agentHost.answerQuestion(questionId, answer, selectedIndices);
});

/**
 * Steer additional user input into an already-running session without
 * interrupting the current agent loop. If the agent is not running,
 * the message is still saved but the handler starts a new run.
 */
ipcMain.handle("agent:steer", async (_event, input: string, sessionId: string, agentName?: string) => {
  const isRunning = await agentHost.steerInput(input, sessionId, agentName);
  if (!isRunning) {
    // No active agent loop — start a new run
    agentHost.setRunning(true);
    try {
      for await (const _event of agentHost.run(input, sessionId, [], agentName)) {
        // events forwarded via subscriber
      }
    } catch (err) {
      mainWindow?.webContents.send("agent:event", {
        type: "error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      agentHost.setRunning(false);
    }
  }
});

// ── IPC: Cron (scheduled tasks) ───────────────────────────────────────────

ipcMain.handle("cron:create", (_event, cron: string, prompt: string, options?: Record<string, unknown>) => {
  return agentHost.createCronTask(cron, prompt, options as any);
});

ipcMain.handle("cron:pause", (_event, id: string) => {
  return agentHost.pauseCronTask(id);
});

ipcMain.handle("cron:resume", (_event, id: string) => {
  return agentHost.resumeCronTask(id);
});

ipcMain.handle("cron:delete", (_event, id: string) => {
  return agentHost.deleteCronTask(id);
});

ipcMain.handle("cron:delete-all", () => {
  agentHost.deleteAllCronTasks();
  return { ok: true };
});

ipcMain.handle("cron:list", () => {
  return agentHost.listCronTasks();
});

// ── IPC: Settings ──

ipcMain.handle("settings:get", () => {
  return agentHost.getSettings();
});

ipcMain.handle("settings:save", (_event, settings: Record<string, unknown>) => {
  agentHost.configure(settings as any);
  return agentHost.getSettings();
});

ipcMain.handle("settings:setActiveProfile", (_event, profileId: string) => {
  agentHost.setActiveProfile(profileId);
  return agentHost.getSettings();
});

// ── IPC: Projects ──

ipcMain.handle("projects:list", async () => {
  return agentHost.getProjectStore().list();
});

ipcMain.handle("projects:get", async (_event, id: string) => {
  return agentHost.getProjectStore().get(id);
});

ipcMain.handle("projects:create", async (_event, data: { name: string; description?: string }) => {
  const now = new Date().toISOString();
  return agentHost.getProjectStore().create({
    id: crypto.randomUUID(),
    name: data.name,
    description: data.description ?? "",
    created: now,
    updated: now,
  });
});

ipcMain.handle("projects:update", async (_event, id: string, update: Record<string, unknown>) => {
  return agentHost.getProjectStore().update(id, update as any);
});

ipcMain.handle("projects:delete", async (_event, id: string) => {
  await agentHost.getProjectStore().delete(id);
});

ipcMain.handle("projects:checkPath", async (_event, path: string) => {
  return existsSync(path);
});

// ── IPC: Sessions ──

ipcMain.handle("sessions:list", async (_event, projectId?: string) => {
  return agentHost.getSessionStore().list(projectId);
});

ipcMain.handle("sessions:listChildren", async (_event, parentId: string) => {
  return agentHost.getSessionStore().listChildren(parentId);
});

ipcMain.handle("sessions:get", async (_event, id: string) => {
  return agentHost.getSessionStore().get(id);
});

ipcMain.handle("sessions:create", async (_event, title: string, projectId?: string) => {
  return agentHost.createSession(title, projectId);
});

ipcMain.handle("sessions:delete", async (_event, id: string) => {
  // Release cron locks held by this session and re-assign to sibling sessions
  await agentHost.onSessionDeleted(id);
  await agentHost.getSessionStore().delete(id);
});

// ── IPC: Memory ──

ipcMain.handle("memory:list", async () => {
  return agentHost.getMemoryStore().list();
});

ipcMain.handle("memory:get", async (_event, name: string) => {
  return agentHost.getMemoryStore().get(name);
});

ipcMain.handle("memory:set", async (_event, entry: Record<string, unknown>) => {
  await agentHost.getMemoryStore().set(entry as any);
});

ipcMain.handle("memory:delete", async (_event, name: string) => {
  await agentHost.getMemoryStore().delete(name);
});

ipcMain.handle("memory:search", async (_event, query: string) => {
  return agentHost.getMemoryStore().search(query);
});

// ── IPC: MCP Servers ──

ipcMain.handle("mcp:list", async () => {
  return agentHost.getMCPStore().listAll();
});

ipcMain.handle("mcp:save", async (_event, server: Record<string, unknown>) => {
  await agentHost.getMCPStore().save(server as any);
});

ipcMain.handle("mcp:delete", async (_event, id: string) => {
  await agentHost.getMCPStore().delete(id);
});

ipcMain.handle("mcp:setEnabled", async (_event, id: string, enabled: boolean) => {
  await agentHost.getMCPStore().setEnabled(id, enabled);
});

ipcMain.handle("mcp:probe", async (_event, server: Record<string, unknown>) => {
  return agentHost.probeServerTools(server as any);
});

// ── IPC: LSP ──

ipcMain.handle("lsp:list", async () => {
  return agentHost.getLSPStore().listAll();
});

ipcMain.handle("lsp:save", async (_event, config: Record<string, unknown>) => {
  await agentHost.getLSPStore().save(config as any);
});

ipcMain.handle("lsp:delete", async (_event, id: string) => {
  await agentHost.getLSPStore().delete(id);
});

ipcMain.handle("lsp:setEnabled", async (_event, id: string, enabled: boolean) => {
  await agentHost.getLSPStore().setEnabled(id, enabled);
});

// ── IPC: Skills ──

ipcMain.handle("skills:list", async () => {
  try {
    const result = await agentHost.listSkills();
    console.log("[skills:list] workingDir:", (agentHost as any).workingDirectory, "found:", result.length);
    return result;
  } catch (err) {
    console.error("[skills:list] ERROR:", err);
    return [];
  }
});

ipcMain.handle("skills:save", async (_event, skill: Record<string, unknown>) => {
  await agentHost.getSkillStore().save(skill as any);
});

ipcMain.handle("skills:delete", async (_event, name: string) => {
  await agentHost.getSkillStore().delete(name);
});

ipcMain.handle("skills:set-enabled", async (_event, name: string, enabled: boolean) => {
  await agentHost.getSkillStore().setEnabled(name, enabled);
});

ipcMain.handle("skills:import", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "导入技能",
    buttonLabel: "导入",
    properties: ["openDirectory", "openFile"],
    filters: [{ name: "Skill", extensions: ["md"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return agentHost.importSkill(result.filePaths[0]);
});

// ── IPC: Upload ──

ipcMain.handle("upload:list", async () => {
  return agentHost.getUploadStore().list();
});

ipcMain.handle("upload:get", async (_event, id: string) => {
  return agentHost.getUploadStore().get(id);
});

ipcMain.handle("upload:save", async (_event, entry: Record<string, unknown>) => {
  await agentHost.getUploadStore().save(entry as any);
});

ipcMain.handle("upload:delete", async (_event, id: string) => {
  await agentHost.getUploadStore().delete(id);
});

// ── IPC: File operations ──

ipcMain.handle("file:dialog:open", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openDirectory", "createDirectory"],
    title: "选择项目文件夹",
    buttonLabel: "选择此文件夹",
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("project:set-working-dir", (_event, path: string) => {
  agentHost.setWorkingDirectory(path);
  return { ok: true, path };
});

ipcMain.handle("file:read", async (_event, path: string) => {
  return readFile(path, "utf-8");
});

ipcMain.handle("file:write", async (_event, path: string, content: string) => {
  await writeFile(path, content, "utf-8");
  return true;
});

// ── IPC: Agent Definitions ──

ipcMain.handle("agentdef:list", async () => {
  const list = await agentHost.getAgentStore().list();
  const settings = agentHost.getSettings();
  const activeSet = new Set<string>(settings.activeAgentIds ?? []);
  return list.map((a) => ({ ...a, isActive: activeSet.has(a.id) }));
});

ipcMain.handle("agentdef:get", async (_event, id: string) => {
  return agentHost.getAgentStore().get(id);
});

ipcMain.handle("agentdef:create", async (_event, data: Record<string, unknown>) => {
  const now = new Date().toISOString();
  return agentHost.getAgentStore().create({
    id: crypto.randomUUID(),
    name: (data.name as string) ?? "新智能体",
    description: (data.description as string) ?? "",
    systemPrompt: (data.systemPrompt as string) ?? "",
    contextPlaceholders: (data.contextPlaceholders as any[]) ?? [],
    capabilities: (data.capabilities as any) ?? { profileId: "", enabledTools: [], enabledSkills: [], enabledMCPServers: [] },
    maxIterations: (data.maxIterations as number) ?? 0,
    isDefault: Boolean(data.isDefault),
    created: now,
    updated: now,
  });
});

ipcMain.handle("agentdef:update", async (_event, id: string, update: Record<string, unknown>) => {
  return agentHost.getAgentStore().update(id, update as any);
});

ipcMain.handle("agentdef:delete", async (_event, id: string) => {
  await agentHost.getAgentStore().delete(id);
  // Remove from active agents list if present
  const settings = agentHost.getSettings();
  const filtered = (settings.activeAgentIds ?? []).filter((aid) => aid !== id);
  agentHost.setActiveAgentIds(filtered);
});

ipcMain.handle("agentdef:setActive", (_event, id: string) => {
  agentHost.toggleActiveAgent(id);
  return agentHost.getSettings();
});


// ── App lifecycle ──

// When a second instance tries to launch, bring the existing window to front.
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // Allow microphone access for voice input & wake-word listening
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow && !mainWindow.isVisible()) {
    // Dock click while hidden in voice-wake background mode → restore
    mainWindow.show();
    mainWindow.focus();
  }
});
