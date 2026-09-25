import { prepareChromeExtension, showChromeExtensionSetup } from "./ai-hub/chrome-extension-install.js";
// Load electron via createRequire (CJS) instead of ESM `import`, which crashes
// on electron 32 / Node 20.18 (cjsPreparseModuleExports: "exports" undefined).
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, session, shell, desktopCapturer, systemPreferences, screen, globalShortcut, clipboard, powerMonitor, protocol } = require("electron") as typeof import("electron");
import { spawn, type ChildProcess } from "node:child_process";
import { basename, delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { installGlobalLogging } from "@agent/core";
// Must be set before app ready: real host IPs must survive ICE gathering for
// LAN/Tailscale WebRTC (mDNS .local candidates do not resolve on phones).
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");
protocol.registerSchemesAsPrivileged([{
  scheme: "agentroam-preview",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);
import { DesktopInputGateway } from "./desktop-input-gateway.js";
import type { ScreenPermission } from "./desktop-screen-live.js";
import { ComputerRelayServer } from "./computer-use/computer-relay-server.js";
import { DesktopComputerRuntime } from "./computer-use/desktop-computer-runtime.js";
import { DesktopInputAdapter } from "./computer-use/desktop-input-adapter.js";
import { ElectronScreenCaptureAdapter } from "./computer-use/electron-screen-capture-adapter.js";
import { MacAccessibilityAdapter } from "./computer-use/mac-accessibility-adapter.js";
import { readDesktopLiveState, writeDesktopLiveState } from "./desktop-live-state.js";
import { DesktopLiveCliProxy } from "./desktop-live-cli-proxy.js";
import { SharedServiceConnection } from "./shared-service.js";
import { DesktopUpdateService } from "./update-service.js";
import { directoryOpenMenuLabel, revealDirectoryWithShell, resolveDirectoryForOpen } from "./directory-context-menu.js";
import { createDesktopPreviewResponse, DesktopFileWorkspaceService } from "./file-workspace-service.js";
import { AIHubManager, type HubPaneRect } from "./ai-hub/manager.js";
import { normalizeRelayImages, startAiHubRelay, type AiHubRelay } from "./ai-hub/relay.js";
import { BrowserProfileImporter, HUB_PROFILE_DIR_NAME } from "./ai-hub/browser-profile-importer.js";
import { ProfileImportStateStore } from "./ai-hub/import-state.js";
import { isBrowserProfileSourceId, isProcessNameRunning, listBrowserProfileSources, toSourceView } from "./ai-hub/browser-profile-source.js";
import { ChromeHubBridge } from "./ai-hub/chrome-bridge.js";
import { isChromeHubSite, validChromeHubInput } from "./ai-hub/chrome-bridge-protocol.js";
import { openExistingChrome, openChromeExtensions } from "./ai-hub/existing-chrome.js";
import {
  getTtsListeningMode,
  getVoiceCaptureSilenceTimeout,
  getWakeCommandSuffix,
  getVoiceCaptureAction,
  isWakeMatch,
  parseWakeControlLine,
  parseWakeTranscriptLine,
  prepareTtsListening,
  replaceWakeCommandSuffix,
  routeVoiceServiceResult,
  shouldFinalizeVoiceCapture,
  shouldAcceptBargeIn,
  shouldAcceptTtsPlayback,
  shouldInvalidateVoiceProvider,
  shouldRearmIgnoredWakeKeyword,
  shouldRearmWakeOnlyCapture,
  shouldRestartWakeListener,
} from "./voice-capture-state.js";
import {
  VoiceServiceClient,
  type VoiceServiceEvent,
} from "./voice-service-client.js";
import {
  findVoiceServiceEntry,
  findVoiceServiceRuntime,
  getVoiceServiceTtsEnvironment,
  VoiceServiceManager,
  type VoiceProvider,
} from "./voice-service-manager.js";

// Suppress EPIPE errors on stdout/stderr (e.g., when output is piped to `head`)
// Without this, broken pipes cause an uncaught exception that crashes the main process.
process.stdout.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") throw err; });
process.stderr.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") throw err; });

// ── Single-instance lock ──────────────────────────────────────────────────
if (process.env.AGENTROAM_DESKTOP_USER_DATA?.trim()) app.setPath("userData", resolve(process.env.AGENTROAM_DESKTOP_USER_DATA));
// 全局日志唯一装配点(core 的 installGlobalLogging):按天错误日志落在
// <userData>/logs/YYYY-MM-DD.log。桌面壳是长驻 UI 进程,记录后不退出
// (exitOnUncaughtException: false),保持 Electron 默认的「主进程不因单个
// 异常退出」行为,只把报错严格落盘。
const globalLogger = installGlobalLogging({
  dir: join(app.getPath("userData"), "logs"),
  source: "desktop",
  minLevel: "info",
  handlers: { exitOnUncaughtException: false },
});
globalLogger.info("desktop main booting", { version: app.getVersion(), platform: process.platform, userData: app.getPath("userData") });
// Electron uses an OS-level lock tied to the app's userData directory.
// If a second instance starts, it focuses the existing window and quits.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
let mainWindow: import("electron").BrowserWindow | null = null;
const desktopUpdateService = new DesktopUpdateService({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  downloadsDirectory: app.getPath("downloads"),
  reveal: (path) => shell.showItemInFolder(path),
});
desktopUpdateService.subscribe((status) => mainWindow?.webContents.send("update:status", status));
// ── AI Hub 浏览器 Profile 导入 + 共享 Session + 托管 Chrome 重登录 ─────────
const profileImportStateStore = new ProfileImportStateStore(join(app.getPath("userData"), "ai-hub-profile-import.json"));
const profileImporter = new BrowserProfileImporter({
  destRoot: join(app.getPath("userData"), HUB_PROFILE_DIR_NAME),
  stateStore: profileImportStateStore,
  isProcessRunning: isProcessNameRunning,
  onProgress: (phase) => mainWindow?.webContents.send("hub:event", { type: "profile-import", phase }),
});
let importedAiHubProfilePath: string | null = null;
const chromeHubBridge = new ChromeHubBridge(join(app.getPath("userData"), "ai-hub-chrome-bridge.json"));
const aiHubManager = new AIHubManager({
  configPath: join(app.getPath("userData"), "ai-hub-config.json"),
  getWindow: () => mainWindow,
  getImportedProfilePath: () => importedAiHubProfilePath,
  chromeBridge: chromeHubBridge,
  requestBrowserLogin: (siteId) => { void openAiHubInChrome(siteId).catch(() => {}); },
});
aiHubManager.subscribe((event) => mainWindow?.webContents.send("hub:event", event));
// AI Hub 中继：供 :3000 server（web 控制台）转发发送请求，由桌面端注入已登录页面
let aiHubRelay: AiHubRelay | null = null;

chromeHubBridge.subscribe((event) => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("hub:chrome-event", event);
});
async function openAiHubInChrome(siteId: string): Promise<void> {
  const site = aiHubManager.getConfig().sites.find((candidate) => candidate.id === siteId);
  if (!site) throw new Error("站点不存在");
  await openExistingChrome(site.url);
}
function chromeExtensionPath(): string {
  const source = app.isPackaged ? join(process.resourcesPath, "chrome-extension") : join(app.getAppPath(), "chrome-extension");
  return prepareChromeExtension(source, join(app.getPath("userData"), "ai-hub-chrome-extension"), chromeHubBridge.pairingCode());
}
const appIconPath = [
  join(app.getAppPath(), "assets", "app-icon.png"),
  join(process.resourcesPath, "assets", "app-icon.png"),
  join(process.resourcesPath, "app.asar.unpacked", "assets", "app-icon.png"),
].find((candidate) => existsSync(candidate));
const sharedService = new SharedServiceConnection(join(app.getPath("userData"), "shared-service.json"));
const desktopLiveProxy = new DesktopLiveCliProxy({
  request: (path, method, body) => sharedService.json(path, method, body),
  onStatus: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop-live:status", status);
    const controlled = status.enabled && status.controlState !== null && status.controlState !== "agent-controlled";
    if (process.platform === "darwin") app.dock?.setBadge(controlled ? "●" : "");
  },
});
const fileWorkspaceService = new DesktopFileWorkspaceService({
  roots: (process.env.AGENT_WEB_ROOTS?.trim() || homedir()).split(delimiter),
  home: homedir(),
  emit: (event) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("file-workspace:event", { events: [event] });
    }
  },
});
const trustedServiceSender = (event: import("electron").IpcMainInvokeEvent) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted desktop sender");
};
ipcMain.handle("service:status", (event) => { trustedServiceSender(event); return sharedService.status(); });
ipcMain.handle("service:select", async (event, id: string) => {
  trustedServiceSender(event);
  const selected = await sharedService.select(id);
  await desktopLiveProxy.refresh().catch(() => undefined);
  return selected;
});
ipcMain.handle("service:request", (event, path: string, method: string, body?: string) => { trustedServiceSender(event); return sharedService.json(path, method, body); });
ipcMain.handle("service:stream", (event, id: string, path: string, lastEventId: string) => {
  trustedServiceSender(event);
  void sharedService.stream(id, path, lastEventId, (frame) => { if (!event.sender.isDestroyed()) event.sender.send("service:stream-frame", frame); }).catch(() => {
    if (!event.sender.isDestroyed()) event.sender.send("service:stream-frame", { id, type: "error" });
  });
});
ipcMain.handle("service:stream-stop", (event, id: string) => { trustedServiceSender(event); sharedService.stop(id); });
ipcMain.handle("tool-policies:list", async (event) => {
  trustedServiceSender(event);
  return parseServiceJson(await sharedService.json("/api/tool-policies", "GET"));
});
ipcMain.handle("tool-policies:save", async (event, policy: Record<string, unknown>, exists: boolean) => {
  trustedServiceSender(event);
  const id = typeof policy?.id === "string" ? encodeURIComponent(policy.id) : "";
  const response = await sharedService.json(exists ? `/api/tool-policies/${id}` : "/api/tool-policies", exists ? "PUT" : "POST", JSON.stringify(policy));
  return parseServiceJson(response);
});
ipcMain.handle("tool-policies:delete", async (event, policyId: string) => {
  trustedServiceSender(event);
  return parseServiceJson(await sharedService.json(`/api/tool-policies/${encodeURIComponent(policyId)}`, "DELETE"));
});

function parseServiceJson(response: { status: number; body: string }): unknown {
  const body = JSON.parse(response.body || "{}");
  if (response.status >= 400) throw new Error(body.error || `Service request failed: ${response.status}`);
  return body;
}
const voiceServiceCwd = app.isPackaged
  ? process.resourcesPath
  : join(app.getAppPath(), "..", "..");
const voiceServicePort = process.env.VOICE_SERVICE_PORT ?? "17863";
const voiceServiceManager = new VoiceServiceManager({
  remoteUrl: process.env.VOICE_SERVICE_URL?.trim() || null,
  remoteToken: process.env.VOICE_SERVICE_TOKEN?.trim() || null,
  localUrl: `http://127.0.0.1:${voiceServicePort}`,
  localToken: null,
  serviceEntry: findVoiceServiceEntry(app.getAppPath(), process.resourcesPath),
  runtimeExecutable: findVoiceServiceRuntime({
    explicit: process.env.VOICE_SERVICE_NODE_BINARY?.trim() || null,
    pathEnv: process.env.PATH,
    resourcesPath: process.resourcesPath,
  }),
  cwd: voiceServiceCwd,
  env: {
    VOICE_ASR_MODEL_DIR: process.env.VOICE_ASR_MODEL_DIR
      ?? join(app.getAppPath(), ".agent-data", "asr-models", "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"),
    ...getVoiceServiceTtsEnvironment({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      env: process.env,
    }),
  },
});
let activeVoiceProvider: VoiceProvider | null = null;
let voiceProviderPromise: Promise<VoiceProvider> | null = null;

async function connectVoiceProvider(): Promise<VoiceProvider> {
  if (activeVoiceProvider) return activeVoiceProvider;
  if (!voiceProviderPromise) {
    voiceProviderPromise = voiceServiceManager.connect()
      .then((provider) => {
        activeVoiceProvider = provider;
        return provider;
      })
      .finally(() => { voiceProviderPromise = null; });
  }
  return voiceProviderPromise;
}

function invalidateVoiceProvider(provider: VoiceProvider): void {
  if (!shouldInvalidateVoiceProvider(activeVoiceProvider, provider)) return;
  if (provider.kind === "service") provider.client.close();
  activeVoiceProvider = null;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    ...(appIconPath ? { icon: appIconPath } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    titleBarStyle: "hiddenInset",
    title: "agentroam",
  });
  const window = mainWindow;
  // 渲染进程崩溃与消失严格落盘(按天错误日志)。
  window.webContents.on("render-process-gone", (_event, details) => {
    globalLogger.error("renderer process gone", undefined, {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    globalLogger.error("preload script failed", error, { preloadPath });
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    sharedService.closeStreams();
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

// 渲染层全局错误经此落入主进程的按天日志文件(source=desktop-renderer)。
ipcMain.handle("client-log:report", (_event, payload: unknown) => {
  try {
    const entry = (payload ?? {}) as { level?: unknown; message?: unknown; error?: unknown; data?: unknown };
    const level = entry.level === "warn" ? "warn" : "error";
    const message = typeof entry.message === "string" ? entry.message.slice(0, 4000) : "renderer error";
    globalLogger.log(level, message, entry.error, { renderer: true, ...(typeof entry.data === "object" && entry.data !== null ? entry.data as Record<string, unknown> : {}) });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

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

ipcMain.handle("update:get-status", () => desktopUpdateService.getStatus());
ipcMain.handle("update:check", () => desktopUpdateService.check());
ipcMain.handle("update:install", () => desktopUpdateService.install());

// ── IPC: AI Hub (embedded multi-AI web aggregation) ─────────────────────

ipcMain.handle("hub:get-config", () => aiHubManager.getConfig());
ipcMain.handle("hub:set-config", (_event, raw: unknown) => aiHubManager.setConfig(raw));
ipcMain.handle("hub:open", (_event, siteId: string, conversationId?: string) => aiHubManager.openSite(siteId, { conversationId }));
ipcMain.handle("hub:close", (_event, siteId: string, conversationId?: string) => aiHubManager.closeSite(siteId, conversationId));
ipcMain.handle("hub:hide-all", () => aiHubManager.setBounds([]));
ipcMain.handle("hub:set-bounds", (_event, panes: HubPaneRect[]) => aiHubManager.setBounds(panes));
ipcMain.handle("hub:reload", (_event, siteId: string, conversationId?: string) => aiHubManager.reloadSite(siteId, conversationId));
ipcMain.handle("hub:broadcast", (_event, text: string, siteIds: string[], images: unknown = []) => aiHubManager.broadcast(text, siteIds, normalizeRelayImages(images)));

// ── IPC: AI Hub 浏览器 Profile 导入 / 共享身份 / 托管重登录 ───────────────
// 边界：渲染层只允许提交固定来源 id；主进程校验后自行解析路径与 Keychain。

ipcMain.handle("hub:list-profile-sources", async () => {
  if (process.platform !== "darwin") return [];
  const sources = await listBrowserProfileSources();
  return sources.map(toSourceView);
});

ipcMain.handle("hub:import-profile", (_event, sourceId: unknown): Promise<unknown> => {
  if (!isBrowserProfileSourceId(sourceId)) {
    throw new Error("unknown-profile-source");
  }
  return profileImporter.import(sourceId);
});

ipcMain.handle("hub:get-profile-import-status", () => profileImporter.getStatus());

ipcMain.handle("hub:restart-after-profile-import", () => {
  app.relaunch();
  app.quit();
});

ipcMain.handle("hub:open-chrome", (_event, siteId: string) => openAiHubInChrome(siteId));
ipcMain.handle("hub:chrome-status", () => chromeHubBridge.status());
ipcMain.handle("hub:chrome-resume", () => chromeHubBridge.resume());
ipcMain.handle("hub:chrome-conversation", (_event, siteId: string) => chromeHubBridge.conversation(siteId));
ipcMain.handle("hub:chrome-frame", (_event, siteId: string) => chromeHubBridge.frame(siteId));
ipcMain.handle("hub:chrome-copy-pairing", async () => { await clipboard.writeText(chromeHubBridge.pairingCode()); });
ipcMain.handle("hub:chrome-reveal-extension", () => { shell.showItemInFolder(join(chromeExtensionPath(), "manifest.json")); });
ipcMain.handle("hub:chrome-install-extension", (event) => {
  trustedServiceSender(event);
  return showChromeExtensionSetup({
    prepare: chromeExtensionPath,
    copyPath: (path) => clipboard.writeText(path),
    reveal: (path) => shell.showItemInFolder(path),
    openManager: () => openChromeExtensions(),
  });
});
ipcMain.handle("hub:chrome-input", (_event, siteId: unknown, input: unknown) => {
  if (typeof siteId !== "string" || !isChromeHubSite(siteId) || !validChromeHubInput(input)) throw new Error("无效的 Chrome 操作");
  return chromeHubBridge.request(siteId, "input", { input });
});

// ── IPC: Native voice wake (macOS Speech framework helper) ──────────────
// The helper streams transcripts over stdout; on wake-word match we restore
// the window and notify the renderer to play the wake animation.
let wakeProc: ChildProcess | null = null;
type WakeHelperMode = "wake" | "dictation" | "barge-in";
let wakeProcMode: WakeHelperMode | null = null;
let wakeVoiceClient: VoiceServiceClient | null = null;
let wakeLaunchGeneration = 0;
let asrSessionState = {
  sessionId: "",
  generation: 0,
  lastFinalUtteranceId: 0,
};
let wakeWordCurrent = "小智";
let wakeVariants: string[] = ["小智"];
// true while the renderer asked for wake listening; used to auto-restart
// the helper if it crashes while the window stays hidden.
let wakeDesired = false;
let wakeSuspendedForTts = false;
let dictationActive = false;

// Homophone groups for common wake-word characters, so ASR mishearings like
// "小志"/"小知" still count as the wake word.
const HOMOPHONE_GROUPS: Record<string, string> = {
  智: "智志知芝之值纸至治制置致秩稚镇",
  小: "小晓",
};

function buildWakeVariants(word: string): string[] {
  const variants = new Set<string>([word]);
  for (let i = 0; i < word.length; i++) {
    const group = HOMOPHONE_GROUPS[word[i]];
    if (group) {
      for (const ch of group) variants.add(word.slice(0, i) + ch + word.slice(i + 1));
    }
  }
  return [...variants];
}

function stopWakeProc(): void {
  wakeLaunchGeneration += 1;
  wakeVoiceClient?.stopAsr();
  wakeVoiceClient = null;
  if (wakeProc) {
    wakeProc.kill();
    wakeProc = null;
    wakeProcMode = null;
  }
}

// ── Post-wake voice-command capture ──────────────────────────────────────
// After the wake word fires we keep the helper alive briefly and collect
// what the user says next as a command for the agent. Silence (3s without a
// new transcript) or a hard cap ends the capture; the command is delivered
// to the renderer via the "wake:command" event.
let capturing = false;
let captureCur = "";
let captureSilenceTimer: NodeJS.Timeout | null = null;
let captureHardTimer: NodeJS.Timeout | null = null;

function clearCaptureTimers(): void {
  if (captureSilenceTimer) { clearTimeout(captureSilenceTimer); captureSilenceTimer = null; }
  if (captureHardTimer) { clearTimeout(captureHardTimer); captureHardTimer = null; }
}

function resetCaptureSilenceTimer(): void {
  if (captureSilenceTimer) clearTimeout(captureSilenceTimer);
  captureSilenceTimer = setTimeout(
    finalizeCapture,
    getVoiceCaptureSilenceTimeout(captureCur),
  );
}

function cleanCommand(raw: string): string {
  let text = raw.trim();
  // The transcript often starts with a repeated wake word (or mishearing)
  for (const v of wakeVariants) {
    if (text.startsWith(v)) { text = text.slice(v.length); break; }
  }
  // Drop leftover fillers / punctuation from the wake utterance
  return text.replace(/^[\s，。,.!?！？、喂嗯啊哦]+/, "").trim();
}

function finalizeCapture(): void {
  if (!capturing) return;
  capturing = false;
  clearCaptureTimers();
  // Keep the helper alive: SFSpeechRecognizer has a long warm-up period
  // before it reports anything, so restarting it on every hide/show cycle
  // makes the next wake unreliable. Matches are ignored while visible.
  const full = captureCur;
  captureCur = "";
  const command = cleanCommand(full);
  if (command) {
    console.warn("[wake] captured command:", command);
    mainWindow?.webContents.send("wake:command", { text: command });
  } else {
    console.warn("[wake] capture ended with no command");
  }
  if (!ttsSpeaking && wakeProcMode === "barge-in") {
    setTimeout(() => {
      if (ttsSpeaking || wakeProcMode !== "barge-in") return;
      stopWakeProc();
      if (wakeDesired) launchWakeListener("wake");
    }, 0);
  } else if (!ttsSpeaking && wakeProcMode === "wake" && wakeVoiceClient) {
    setTimeout(() => {
      if (ttsSpeaking || wakeProcMode !== "wake" || !wakeVoiceClient) return;
      stopWakeProc();
      if (wakeDesired) void launchWakeListener("wake");
    }, 0);
  }
}

function startCapture(seed: string, waitForFirstTranscript = false): void {
  capturing = true;
  captureCur = seed;
  clearCaptureTimers();
  captureHardTimer = setTimeout(finalizeCapture, waitForFirstTranscript ? 22000 : 12000);
  if (!waitForFirstTranscript) resetCaptureSilenceTimer();
}

function onCaptureText(heard: string): void {
  // URL recognition emits corrected partials for the same recorded utterance.
  // The newest candidate supersedes earlier hypotheses rather than appending.
  captureCur = replaceWakeCommandSuffix(captureCur, heard);
  resetCaptureSilenceTimer();
}

function replaceCaptureText(heard: string): void {
  captureCur = replaceWakeCommandSuffix(captureCur, heard);
  resetCaptureSilenceTimer();
}

function desiredWakeHelperMode(): WakeHelperMode {
  if (dictationActive) return "dictation";
  return ttsSpeaking && getTtsListeningMode(conversation) === "barge-in"
    ? "barge-in"
    : "wake";
}

async function launchWakeListener(
  mode: WakeHelperMode = desiredWakeHelperMode(),
): Promise<{ ok: boolean; reason?: string }> {
  if (wakeProc) return { ok: true };
  const launchGeneration = ++wakeLaunchGeneration;
  // Preferred: the compiled Swift helper (Speech framework directly). TCC
  // attribution belongs to Electron, whose Info.plist carries the privacy
  // descriptions. Fallback: the JXA script under osascript.
  const search = (name: string) =>
    [
      join(__dirname, "..", "..", "native", name),
      join(process.resourcesPath ?? "", "native", name),
      join(app.getAppPath(), "native", name),
    ].find((p) => existsSync(p));
  const binary = search("wakelistener");
  const script = search("wakelistener.js");
  if (!binary && !script) return { ok: false, reason: "no-helper" };
  const voiceProvider = await connectVoiceProvider();
  if (launchGeneration !== wakeLaunchGeneration) return { ok: false, reason: "cancelled" };
  let serviceClient = voiceProvider.kind === "service"
    ? voiceProvider.client
    : null;
  if (serviceClient && !binary) {
    serviceClient = null;
  }
  let onLine: (line: string) => void = () => {};
  if (serviceClient) {
    asrSessionState = {
      sessionId: `desktop-${process.pid}-${crypto.randomUUID()}`,
      generation: launchGeneration,
      lastFinalUtteranceId: 0,
    };
    try {
      await serviceClient.startAsr({
        sessionId: asrSessionState.sessionId,
        generation: asrSessionState.generation,
        mode,
        ...(mode === "wake" ? { wakeWord: wakeWordCurrent } : {}),
      }, (event: VoiceServiceEvent) => {
        if (event.type === "finished") {
          if (event.sessionId !== asrSessionState.sessionId
            || event.generation !== asrSessionState.generation) return;
          if (dictationActive) {
            dictationActive = false;
            stopWakeProc();
            if (wakeDesired) void launchWakeListener();
          }
          return;
        }
        const routed = routeVoiceServiceResult(asrSessionState, event);
        if (routed.action === "ignore") return;
        asrSessionState.lastFinalUtteranceId = routed.lastFinalUtteranceId;
        if (routed.action === "keyword" && event.type === "keyword") {
          if (shouldRearmIgnoredWakeKeyword(mainWindow?.isVisible() ?? false, wakeDesired)) {
            console.warn("[wake] KWS keyword ignored while visible; rearming wake generation");
            stopWakeProc();
            setTimeout(() => {
              if (wakeDesired && !wakeProc) void launchWakeListener("wake");
            }, 100);
            return;
          }
          console.warn("[wake] *** MATCHED KWS keyword, showing window ***");
          if (mainWindow) {
            mainWindow.show();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
          }
          mainWindow?.webContents.send("wake:trigger", event.keyword);
          startCapture("", true);
          return;
        }
        if (event.type !== "partial" && event.type !== "final") return;
        onLine(`${event.type === "final" ? "FINAL" : "TEXT"} ${event.text}`);
      }, (error) => {
        if (wakeVoiceClient !== serviceClient) return;
        console.warn("[voice] service ASR disconnected; restarting provider:", error.message);
        invalidateVoiceProvider(voiceProvider);
        stopWakeProc();
        setTimeout(() => {
          if (wakeDesired && !wakeProc) void launchWakeListener(desiredWakeHelperMode());
        }, 100);
      });
    } catch (error) {
      console.warn("[voice] service ASR unavailable, using native fallback:", error);
      invalidateVoiceProvider(voiceProvider);
      serviceClient = null;
    }
  }
  if (launchGeneration !== wakeLaunchGeneration) {
    serviceClient?.stopAsr();
    return { ok: false, reason: "cancelled" };
  }
  const useExternalAsr = Boolean(serviceClient && binary);
  const proc = binary
    ? spawn(binary, ["zh-CN", useExternalAsr ? `external-${mode}` : mode])
    : spawn("osascript", ["-l", "JavaScript", script as string]);
  wakeProc = proc;
  wakeProcMode = mode;
  wakeVoiceClient = useExternalAsr ? serviceClient : null;
  console.warn("[wake] helper spawned", { pid: proc.pid, mode, externalAsr: useExternalAsr });
  // The Swift binary prints the protocol to stdout; JXA's console.log goes
  // to stderr. Parse both streams the same way.
  let buf = "";
  const onChunk = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      onLine(line);
    }
  };
  if (useExternalAsr) {
    proc.stdout?.on("data", (chunk: Buffer) => wakeVoiceClient?.sendPcm(chunk));
    proc.stderr?.on("data", onChunk);
  } else {
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
  }
  onLine = (line: string) => {
    const control = parseWakeControlLine(line);
    if (control === "barge-in") {
      interruptTtsForBargeIn();
      return;
    }
    const transcript = parseWakeTranscriptLine(line);
    if (transcript) {
      // Echo protection: while the app is speaking, the mic hears the
      // speaker — those transcripts must never trigger anything.
      if (ttsSpeaking) return;
      const { heard, isFinal } = transcript;
      console.warn("[wake] heard:", heard);
      if (dictationActive) {
        mainWindow?.webContents.send("dictation:result", { text: heard, isFinal });
        if (isFinal) {
          dictationActive = false;
          stopWakeProc();
          if (wakeDesired) launchWakeListener();
        }
        return;
      }
      if (isWakeMatch(heard, wakeVariants, isFinal)) {
        const commandSuffix = getWakeCommandSuffix(heard, wakeVariants);
        // Only wake from hidden mode; while visible the match is ignored so
        // casual conversation can't trigger sessions. The helper keeps
        // running (warm) either way.
        if (capturing) {
          if (commandSuffix !== null) replaceCaptureText(commandSuffix);
          if (shouldRearmWakeOnlyCapture(capturing, isFinal, captureCur)) {
            startCapture("");
            return;
          }
          if (shouldFinalizeVoiceCapture(capturing, isFinal, captureCur)) finalizeCapture();
          return;
        }
        if (mainWindow?.isVisible()) {
          // Visible + conversation mode: the wake word is just a filler
          // here — treat the utterance as a follow-up command.
          if (conversation) {
            startCapture(commandSuffix ?? "");
            if (shouldFinalizeVoiceCapture(capturing, isFinal, captureCur)) finalizeCapture();
          }
          return;
        }
        console.warn("[wake] *** MATCHED wake word, showing window ***");
        if (mainWindow) {
          mainWindow.show();
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
        mainWindow?.webContents.send("wake:trigger", heard);
        // Keep the helper alive and capture the spoken command that
        // follows the wake word.
        startCapture(commandSuffix ?? "");
        if (shouldFinalizeVoiceCapture(capturing, isFinal, captureCur)) finalizeCapture();
      } else {
        const action = getVoiceCaptureAction(capturing, conversation);
        if (action === "append") {
          onCaptureText(heard);
        } else if (action === "start") {
          // Two-way voice conversation: the first transcript after a reply
          // starts a fresh command capture without requiring the wake word.
          startCapture(heard);
        }
        if (shouldFinalizeVoiceCapture(capturing, isFinal, captureCur)) finalizeCapture();
      }
    } else if (line.startsWith("ERROR ") && dictationActive) {
      const detail = line.slice(6);
      const message = detail.includes("1110") ? "未识别到语音" : `语音识别失败：${detail}`;
      dictationActive = false;
      mainWindow?.webContents.send("dictation:error", message);
      stopWakeProc();
      if (wakeDesired) launchWakeListener();
    } else if (line === "EXIT") {
      stopWakeProc();
    } else if (line === "READY") {
      console.warn("[wake] helper ready");
    } else if (line) {
      console.warn("[wake]", line);
    }
  };
  proc.on("error", (err) => {
    console.warn("[wake] spawn error:", err.message);
  });
  proc.on("exit", (code, signal) => {
    console.warn("[wake] helper exited, code:", code, "signal:", signal);
    if (wakeProc === proc) {
      wakeProc = null;
      wakeProcMode = null;
      wakeVoiceClient?.close();
      wakeVoiceClient = null;
    }
    // Helper died mid-capture — deliver whatever was collected so far.
    if (capturing) finalizeCapture();
    // Auto-recover: relaunch the helper after an unexpected exit/crash
    // while wake listening is desired (warm recognizer = reliable wake).
    if (shouldRestartWakeListener(wakeDesired, wakeSuspendedForTts)) {
      setTimeout(() => {
        if (shouldRestartWakeListener(wakeDesired, wakeSuspendedForTts) && !wakeProc) {
          console.warn("[wake] auto-restarting helper");
          void launchWakeListener();
        }
      }, 1500);
    }
  });
  return { ok: true };
}

ipcMain.handle("wake:start", (_event, wakeWord: string) => {
  wakeWordCurrent = wakeWord || "小智";
  wakeVariants = buildWakeVariants(wakeWordCurrent);
  wakeDesired = true;
  return launchWakeListener();
});

ipcMain.handle("wake:stop", () => {
  wakeDesired = false;
  // The renderer stops wake listening on window focus; keep the helper
  // alive while it is still capturing a voice command.
  if (!capturing && !dictationActive) stopWakeProc();
  return { ok: true };
});

ipcMain.handle("dictation:start", () => {
  if (dictationActive) return { ok: true };
  dictationActive = true;
  capturing = false;
  captureCur = "";
  clearCaptureTimers();
  stopWakeProc();
  return launchWakeListener();
});

ipcMain.handle("dictation:stop", () => {
  if (dictationActive && wakeVoiceClient) wakeVoiceClient.finishAsr();
  else if (dictationActive && wakeProc) wakeProc.kill("SIGUSR1");
  return { ok: true };
});

ipcMain.handle("window:isVisible", () => {
  return mainWindow?.isVisible() ?? false;
});

// ── Service TTS + two-way voice conversation ────────────────────────────
let ttsSpeaking = false;
let ttsGraceTimer: NodeJS.Timeout | null = null;
let ttsAbortController: AbortController | null = null;
let ttsGeneration = 0;
let conversation = false;
let conversationTimer: NodeJS.Timeout | null = null;

function cancelActiveTts(): number {
  const cancelledGeneration = ttsGeneration;
  ttsGeneration += 1;
  ttsAbortController?.abort();
  ttsAbortController = null;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("tts:flush", { generation: cancelledGeneration });
  }
  return cancelledGeneration;
}

function resumeWakeAfterTts(): void {
  wakeSuspendedForTts = false;
  ttsSpeaking = false;
  if (wakeProcMode === "barge-in") stopWakeProc();
  if (shouldRestartWakeListener(wakeDesired, wakeSuspendedForTts) && !wakeProc) {
    void launchWakeListener("wake");
  }
}

function interruptTtsForBargeIn(): void {
  if (!shouldAcceptBargeIn(ttsSpeaking, conversation)) return;
  console.warn("[tts] barge-in detected, stopping current speech");
  const generation = cancelActiveTts();
  if (ttsGraceTimer) { clearTimeout(ttsGraceTimer); ttsGraceTimer = null; }
  ttsSpeaking = false;
  wakeSuspendedForTts = false;
  if (!capturing) startCapture("", true);
  mainWindow?.webContents.send("tts:end", { generation });
}

function finishTtsPlayback(generation: number): void {
  if (!shouldAcceptTtsPlayback(generation, ttsGeneration, ttsSpeaking)) return;
  ttsAbortController = null;
  ttsSpeaking = false;
  mainWindow?.webContents.send("tts:end", { generation });
  if (ttsGraceTimer) clearTimeout(ttsGraceTimer);
  ttsGraceTimer = setTimeout(resumeWakeAfterTts, 100);
}

function synthesizeAndStream(
  text: string,
  generation: number,
  controller: AbortController,
): Promise<boolean> {
  let resolveStarted!: (started: boolean) => void;
  const started = new Promise<boolean>((resolve) => { resolveStarted = resolve; });
  let startSettled = false;
  let provider: VoiceProvider | null = null;
  const settleStart = (value: boolean) => {
    if (startSettled) return;
    startSettled = true;
    resolveStarted(value);
  };

  void (async () => {
    try {
      provider = await connectVoiceProvider();
      if (provider.kind !== "service") throw new Error("TTS model service is unavailable");
      await provider.client.streamSynthesize({
        sessionId: `tts-${process.pid}`,
        generation,
        text,
        voice: "Serena",
        speed: 1,
      }, controller.signal, {
        onStarted: (metadata) => {
          if (!shouldAcceptTtsPlayback(generation, ttsGeneration, ttsSpeaking)) {
            controller.abort();
            settleStart(false);
            return;
          }
          console.warn("[tts] stream started", { generation, sampleRate: metadata.sampleRate });
          mainWindow?.webContents.send("tts:start", metadata);
          settleStart(true);
        },
        onPcm: (pcm) => {
          if (!shouldAcceptTtsPlayback(generation, ttsGeneration, ttsSpeaking)) return;
          const bytes = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
          mainWindow?.webContents.send("tts:pcm", { generation, pcm: bytes });
        },
      });
      if (!shouldAcceptTtsPlayback(generation, ttsGeneration, ttsSpeaking)) return;
      ttsAbortController = null;
      mainWindow?.webContents.send("tts:stream-end", { generation });
    } catch (error) {
      settleStart(false);
      if (controller.signal.aborted) return;
      if (provider) invalidateVoiceProvider(provider);
      console.warn("[tts] model stream failed; playback cancelled:", error);
      if (shouldAcceptTtsPlayback(generation, ttsGeneration, ttsSpeaking)) {
        ttsAbortController = null;
        mainWindow?.webContents.send("tts:flush", { generation });
        mainWindow?.webContents.send("tts:end", { generation });
        resumeWakeAfterTts();
      }
    }
  })();
  return started;
}

function endConversation(): void {
  conversation = false;
  if (conversationTimer) { clearTimeout(conversationTimer); conversationTimer = null; }
}

ipcMain.handle("tts:speak", async (_event, text: string) => {
  const clean = (text || "")
    .replace(/[*_#`>~\[\](){}|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  if (!clean) return { ok: false };
  cancelActiveTts();
  const generation = ttsGeneration;
  const controller = new AbortController();
  ttsAbortController = controller;
  if (ttsGraceTimer) { clearTimeout(ttsGraceTimer); ttsGraceTimer = null; }
  ttsSpeaking = true;
  const listeningMode = getTtsListeningMode(conversation);
  wakeSuspendedForTts = listeningMode === "suspended";
  await prepareTtsListening(
    listeningMode,
    wakeProcMode,
    stopWakeProc,
    () => launchWakeListener("barge-in"),
  );
  if (!shouldAcceptTtsPlayback(generation, ttsGeneration, ttsSpeaking)) {
    return { ok: false };
  }
  return { ok: await synthesizeAndStream(clean, generation, controller) };
});

ipcMain.handle("tts:stop", () => {
  const generation = cancelActiveTts();
  if (ttsGraceTimer) { clearTimeout(ttsGraceTimer); ttsGraceTimer = null; }
  ttsSpeaking = false;
  mainWindow?.webContents.send("tts:end", { generation });
  resumeWakeAfterTts();
  return { ok: true };
});

ipcMain.handle("tts:playback-ended", (_event, generation: number) => {
  finishTtsPlayback(generation);
  return { ok: true };
});

// Conversation mode: while on, any utterance is captured as a follow-up
// command (no wake word needed). Auto-expires after 90s; the renderer
// re-arms it on every voice command it processes.
ipcMain.handle("wake:conversation", (_event, on: boolean) => {
  if (on) {
    conversation = true;
    if (conversationTimer) clearTimeout(conversationTimer);
    conversationTimer = setTimeout(endConversation, 90000);
  } else {
    endConversation();
  }
  return { ok: true, conversation };
});

// Business operations use the shared service. Only device file pickers stay local.
ipcMain.handle("file:dialog:open", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"], title: "选择项目文件夹", buttonLabel: "选择此文件夹" });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("file-workspace:request", (event, method, params) => {
  trustedServiceSender(event);
  return fileWorkspaceService.request(method, params);
});
ipcMain.handle("directory:show-context-menu", async (event, path: unknown) => {
  trustedServiceSender(event);
  const directory = await resolveDirectoryForOpen(path);
  const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
  const menu = Menu.buildFromTemplate([{
    label: directoryOpenMenuLabel(),
    click: () => {
      try {
        revealDirectoryWithShell(directory, (target) => shell.showItemInFolder(target));
      } catch (error) {
        globalLogger.error("failed to open project directory", error instanceof Error ? error : new Error(String(error)), { directory });
      }
    },
  }]);
  menu.popup(owner ? { window: owner } : undefined);
  return { shown: true };
});
ipcMain.handle("file:read", (_event, path: string) => readFile(path, "utf-8"));
ipcMain.handle("file:write", async (_event, path: string, content: string) => { await writeFile(path, content, "utf-8"); return true; });
ipcMain.handle("skills:import", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { title: "导入技能", properties: ["openDirectory", "openFile"], filters: [{ name: "Skill", extensions: ["md"] }] });
  if (result.canceled || !result.filePaths.length) return null;
  const response = await sharedService.json("/api/business", "POST", JSON.stringify({ method: "importSkill", args: [result.filePaths[0]] }));
  const body = JSON.parse(response.body);
  if (response.status >= 400) throw new Error(body.error || "导入失败");
  return body;
});

// ── App lifecycle ──

// When a second instance tries to launch, bring the existing window to front.
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── IPC: Desktop live view (screen capture + remote control) ──

const desktopLiveStatePath = join(app.getPath("userData"), "desktop-live.json");
const desktopInputHelperPath = app.isPackaged
  ? join(process.resourcesPath, "bin", "desktop-input")
  : join(__dirname, "../../assets/bin/desktop-input");
let desktopInputGateway: DesktopInputGateway | null = null;
let computerRelay: ComputerRelayServer | null = null;
/** Persisted capture display choice; null = primary. Multi-display Macs can stream either screen. */
let liveDisplayId: string | null = null;

function probeScreenPermission(): ScreenPermission {
  return systemPreferences.getMediaAccessStatus("screen") as ScreenPermission;
}

function pickLiveDisplay(): { display: Electron.Display; id: string; originX: number; originY: number; width: number; height: number; scaleFactor: number } {
  const all = screen.getAllDisplays();
  const chosen = (liveDisplayId && all.find((item) => String(item.id) === liveDisplayId)) || screen.getPrimaryDisplay();
  return {
    display: chosen,
    id: String(chosen.id),
    originX: chosen.bounds.x,
    originY: chosen.bounds.y,
    width: chosen.size.width,
    height: chosen.size.height,
    scaleFactor: chosen.scaleFactor,
  };
}

function getDesktopInputGateway(): DesktopInputGateway {
  if (!desktopInputGateway) {
    desktopInputGateway = new DesktopInputGateway({
      helperPath: desktopInputHelperPath,
      onStderr: (line) => console.log("[desktop-input]", line),
    });
  }
  return desktopInputGateway;
}

async function captureDesktopSources(thumbnailSize: { width: number; height: number }) {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
  return sources.map((source) => {
    const thumbnail = source.thumbnail;
    return {
      id: source.display_id || source.id,
      thumbnail: thumbnail ? {
        toJPEG: (quality: number) => thumbnail.toJPEG(quality),
        getSize: () => thumbnail.getSize(),
      } : null,
    };
  });
}

async function startComputerRelay(): Promise<ComputerRelayServer | null> {
  if (process.platform !== "darwin") return null;
  const gateway = getDesktopInputGateway();
  const capture = new ElectronScreenCaptureAdapter({
    displayInfo: () => {
      const picked = pickLiveDisplay();
      return {
        id: picked.id,
        originX: picked.originX,
        originY: picked.originY,
        width: picked.width,
        height: picked.height,
        scaleFactor: picked.scaleFactor,
      };
    },
    captureSources: captureDesktopSources,
    screenPermission: probeScreenPermission,
  });
  const runtime = new DesktopComputerRuntime({
    accessibility: new MacAccessibilityAdapter(gateway),
    screenCapture: capture,
    input: new DesktopInputAdapter(gateway),
    ownership: () => desktopLiveProxy.getCachedStatus().controlState,
    locked: () => powerMonitor.getSystemIdleState(1) === "locked",
  });
  const relay = new ComputerRelayServer({ runtime });
  await relay.start();
  return relay;
}

async function persistDesktopLiveEnabled(enabled: boolean): Promise<void> {
  const state = await readDesktopLiveState(desktopLiveStatePath);
  await writeDesktopLiveState(desktopLiveStatePath, { enabled, displayId: state.displayId });
}

ipcMain.handle("desktop-live:get-status", async (event) => { trustedServiceSender(event); return desktopLiveProxy.refresh(); });
ipcMain.handle("desktop-live:setup", async (event) => {
  trustedServiceSender(event);
  const initial = await desktopLiveProxy.refresh();
  const status = initial.enabled
    ? await desktopLiveProxy.action("recheck").catch(() => initial)
    : initial;
  return { supported: status.supported, needsSetup: !existsSync(desktopLiveStatePath), status };
});
ipcMain.handle("desktop-live:recheck", (event) => {
  trustedServiceSender(event);
  return desktopLiveProxy.action("recheck");
});
ipcMain.handle("desktop-live:open-permission", async (event, permission: unknown) => {
  trustedServiceSender(event);
  if (permission !== "screen" && permission !== "accessibility") throw new Error("Unknown permission");
  return desktopLiveProxy.action("authorize", permission);
});
ipcMain.handle("desktop-live:restart", (event) => {
  trustedServiceSender(event);
  return desktopLiveProxy.action("restart");
});

// Display selection belongs to the CLI live session and is exposed in the WebApp viewer.
ipcMain.handle("desktop-live:get-displays", (event) => { trustedServiceSender(event); return { displays: [] }; });
ipcMain.handle("desktop-live:set-display", (event) => { trustedServiceSender(event); return { displayId: "" }; });

ipcMain.handle("desktop-live:set-enabled", async (event, enabled: unknown) => {
  trustedServiceSender(event);
  const status = await desktopLiveProxy.action(enabled === true ? "enable" : "disable");
  await persistDesktopLiveEnabled(status.enabled);
  return status;
});

// ── Global shortcut: wake the window straight into the AI Hub page ──
// Alt+Space (Raycast-style) is the default; fall back when taken.
const AI_HUB_WAKE_CANDIDATES = ["Alt+Space", "CmdOrCtrl+Shift+A", "CmdOrCtrl+Shift+H"];

function wakeToAiHub(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("app:wake-aihub");
}

function registerAiHubWakeShortcut(): void {
  for (const accel of AI_HUB_WAKE_CANDIDATES) {
    if (globalShortcut.isRegistered(accel)) continue;
    if (!globalShortcut.register(accel, () => {
      // Already frontmost → hide back to background (voice wake keeps running).
      if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
      else wakeToAiHub();
    })) continue;
    console.log("[shortcut] AI Hub wake:", accel);
    return;
  }
  console.warn("[shortcut] AI Hub wake unavailable, all taken:", AI_HUB_WAKE_CANDIDATES.join(", "));
}

app.whenReady().then(async () => {
  await sharedService.initialize();
  desktopLiveProxy.start();
  protocol.handle("agentroam-preview", (request) => createDesktopPreviewResponse(fileWorkspaceService, request));
  // 暴露完整辅助功能树（AX 驱动/自动化测试依赖）
  app.setAccessibilitySupportEnabled(true);
  if (process.platform === "darwin" && appIconPath) {
    const icon = nativeImage.createFromPath(appIconPath);
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
  }
  // AI Hub 导入快照维护先行：清理遗留 staging、校验/回滚 current，之后才允许打开任何窗格
  const preparedProfile = await profileImporter.prepareForStartup().catch((error) => {
    console.warn("[ai-hub] profile startup maintenance failed:", error instanceof Error ? error.message : "unknown error");
    return { profilePath: null, recovered: false };
  });
  importedAiHubProfilePath = preparedProfile.profilePath;
  if (preparedProfile.recovered) {
    console.warn("[ai-hub] imported profile failed startup validation; rolled back to previous backup");
  }
  await chromeHubBridge.start().then(() => { chromeExtensionPath(); }).catch(() => {
    console.warn("[ai-hub] existing Chrome bridge could not start on the local port");
  });
  // Allow microphone access for voice input & wake-word listening
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  // Desktop live WebRTC: answer getDisplayMedia from the hidden capture page
  // with the primary display, and keep real host IPs in ICE candidates so
  // LAN/Tailscale peers connect without mDNS resolution.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      // Follow the live display selection so a switched capture stream
      // re-negotiates onto the screen the viewer chose.
      const pickedId = pickLiveDisplay().id;
      const source = sources.find((item) => item.display_id === pickedId) ?? sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source });
    });
  }, { useSystemPicker: false });
  createWindow();
  registerAiHubWakeShortcut();
  computerRelay = await startComputerRelay().catch((error) => {
    console.warn("[computer-use] relay unavailable:", error);
    return null;
  });
  aiHubRelay = await startAiHubRelay(aiHubManager).catch((error) => {
    console.warn("[ai-hub] relay unavailable:", error);
    return null;
  });
  desktopUpdateService.schedule();
  void connectVoiceProvider().then((provider) => {
    console.warn("[voice] provider ready:", provider.kind === "service" ? provider.source : "native");
  });
  // The CLI owns remote desktop publication and capture. This persisted value
  // only keeps the local Computer Use display selection and onboarding marker.
  const desktopLivePersisted = await readDesktopLiveState(desktopLiveStatePath);
  liveDisplayId = desktopLivePersisted.displayId;
});

let quitCleanupStarted = false;
let quitCleanupFinished = false;

app.on("before-quit", (event) => {
  if (quitCleanupFinished) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  desktopLiveProxy.close();
  sharedService.closeStreams();
  fileWorkspaceService.close();
  globalShortcut.unregisterAll();
  wakeDesired = false;
  dictationActive = false;
  endConversation();
  if (ttsGraceTimer) { clearTimeout(ttsGraceTimer); ttsGraceTimer = null; }
  ttsSpeaking = false;
  cancelActiveTts();
  stopWakeProc();
  voiceServiceManager.close();
  aiHubRelay?.close();
  const relayToClose = computerRelay;
  computerRelay = null;
  chromeHubBridge.close();
  aiHubManager.destroyAll();
  void Promise.allSettled([
    relayToClose?.close() ?? Promise.resolve(),
    desktopInputGateway?.stop() ?? Promise.resolve(),
  ]).finally(() => {
    quitCleanupFinished = true;
    app.quit();
  });
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
