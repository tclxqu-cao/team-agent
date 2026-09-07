// Load electron via createRequire (CJS) instead of ESM `import`, which crashes
// on electron 32 / Node 20.18 (cjsPreparseModuleExports: "exports" undefined).
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, dialog, nativeImage, session } = require("electron") as typeof import("electron");
import { spawn, type ChildProcess } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { SessionGoalCoordinator, type AgentEvent } from "@agent/core";
import { AgentHost } from "./agent-host.js";
import {
  BrokerRuntimeAdapter,
  createNativeRuntimeBrokerClient,
  createNativeRuntimeBrokerHostRuntime,
  CustomerAgentRuntimeAdapter,
  RuntimeSessionError,
  UnifiedSessionService,
  type AgentType,
} from "./agent-runtime/index.js";
import { resolveDesktopBaseDir } from "./desktop-base-dir.js";
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
// Electron uses an OS-level lock tied to the app's userData directory.
// If a second instance starts, it focuses the existing window and quits.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
let mainWindow: import("electron").BrowserWindow | null = null;
const appIconPath = [
  join(app.getAppPath(), "assets", "app-icon.png"),
  join(process.resourcesPath, "assets", "app-icon.png"),
  join(process.resourcesPath, "app.asar.unpacked", "assets", "app-icon.png"),
].find((candidate) => existsSync(candidate));
const desktopBaseDir = resolveDesktopBaseDir(app.getAppPath(), app.isPackaged, app.getPath("userData"));
const agentHost = new AgentHost(desktopBaseDir);
const nativeRuntimeBroker = createNativeRuntimeBrokerClient({
  runtimeFactory: (callbacks) => createNativeRuntimeBrokerHostRuntime(
    process.env.AGENT_CODEX_BIN?.trim() || "codex",
    callbacks,
    process.env.AGENT_OPENCODE_BIN?.trim() || "opencode",
  ),
});
const unifiedSessions = new UnifiedSessionService(
  [
    new CustomerAgentRuntimeAdapter(agentHost),
    new BrokerRuntimeAdapter("codex", nativeRuntimeBroker),
    new BrokerRuntimeAdapter("claude-code", nativeRuntimeBroker),
    new BrokerRuntimeAdapter("opencode", nativeRuntimeBroker),
  ],
  () => agentHost.getProjectStore().list(),
);
const activeCustomerGoalRuns = new Set<string>();
const customerGoalCoordinator = new SessionGoalCoordinator(
  agentHost.getSessionStore(),
  async (sessionId, objective) => {
    while (true) {
      let outcome: "completed" | "failed" = "completed";
      let reason: string | undefined;
      try {
        activeCustomerGoalRuns.add(sessionId);
        for await (const event of unifiedSessions.run(sessionId, objective)) {
          if (event.type === "error") {
            outcome = "failed";
            reason = event.message;
          } else if (event.type === "turn_aborted") {
            outcome = "failed";
            reason = "Goal was stopped";
          }
        }
        activeCustomerGoalRuns.delete(sessionId);
        return { outcome, reason };
      } catch (error) {
        activeCustomerGoalRuns.delete(sessionId);
        if (!(error instanceof RuntimeSessionError) || error.code !== "SESSION_OCCUPIED") throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  },
  (sessionId) => activeCustomerGoalRuns.has(sessionId)
    ? unifiedSessions.abort(sessionId)
    : Promise.resolve(),
);
const nativeEventForwarders = new Map<string, () => void>();
const nativeDesktopCursors = new Map<string, { runId: string | null; sequence: number }>();

function forwardDesktopNativeEvent(sessionId: string, runId: string, sequence: number, event: AgentEvent): void {
  nativeDesktopCursors.set(sessionId, { runId, sequence });
  mainWindow?.webContents.send("agent:event", {
    ...event,
    _sid: sessionId,
    _nativeRunId: runId,
    _nativeSequence: sequence,
  });
}

async function attachDesktopNativeEventForwarder(
  sessionId: string,
  deliveredCursor?: { runId: string | null; sequence: number },
): Promise<void> {
  nativeEventForwarders.get(sessionId)?.();
  nativeEventForwarders.delete(sessionId);

  const snapshot = await nativeRuntimeBroker.snapshot(sessionId);
  if (snapshot.controller !== "desktop" || !snapshot.runId) return;
  const afterSequence = deliveredCursor?.runId === snapshot.runId
    ? deliveredCursor.sequence
    : 0;
  // The detail returned immediately before a handoff can be older than this
  // snapshot. Replay only that gap, then subscribe after the latest snapshot
  // so the Desktop renderer never loses a pending approval in between.
  for (const { runId, sequence, event } of snapshot.events) {
    if (sequence > afterSequence) {
      forwardDesktopNativeEvent(sessionId, runId, sequence, event);
    }
  }
  nativeDesktopCursors.set(sessionId, {
    runId: snapshot.runId,
    sequence: snapshot.snapshotRevision,
  });

  let unsubscribe: (() => void) | null = null;
  let terminalBeforeSubscriptionReady = false;
  const stop = () => {
    unsubscribe?.();
    if (nativeEventForwarders.get(sessionId) === stop) {
      nativeEventForwarders.delete(sessionId);
    }
  };
  unsubscribe = await nativeRuntimeBroker.subscribe(
    sessionId,
    snapshot.snapshotRevision,
    ({ runId, sequence, event }) => {
      forwardDesktopNativeEvent(sessionId, runId, sequence, event);
      if (event.type === "done" || event.type === "error") {
        terminalBeforeSubscriptionReady = true;
        stop();
      }
    },
  );
  nativeEventForwarders.set(sessionId, stop);
  if (terminalBeforeSubscriptionReady) stop();
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
    ...(appIconPath ? { icon: appIconPath } : {}),
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
  mainWindow?.webContents.send("tts:flush", { generation: cancelledGeneration });
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

// ── IPC: Agent control ──

ipcMain.handle("agent:run", async (_event, input: string, sessionId: string, agentIds?: string[], agentName?: string, images?: string[], nativeOptions?: { model?: { id: string; providerID?: string }; reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" }) => {
  try {
    const agentType = unifiedSessions.agentTypeFor(sessionId);
    const runOptions = agentType === "customer-agent" ? undefined : {
      ...(nativeOptions?.model?.id ? { model: nativeOptions.model } : {}),
      ...(nativeOptions?.reasoningEffort ? { reasoningEffort: nativeOptions.reasoningEffort } : {}),
    };
    for await (const agentEvent of unifiedSessions.run(sessionId, input, images, agentIds, agentName, runOptions)) {
      // Customer Agent already publishes through AgentHost (including cron and
      // sub-agent events). Native adapters publish here with the unified ID.
      if (agentType !== "customer-agent") {
        mainWindow?.webContents.send("agent:event", { ...agentEvent, _sid: sessionId });
      }
    }
  } catch (err) {
    const code = err instanceof RuntimeSessionError ? err.code : undefined;
    mainWindow?.webContents.send("agent:event", {
      type: "error",
      message: err instanceof Error ? err.message : "Unknown error",
      ...(code ? { code } : {}),
      _sid: sessionId,
    });
  }
});

ipcMain.handle("agent:list-models", (_event, agentType: string) => {
  if (agentType !== "codex" && agentType !== "claude-code" && agentType !== "opencode") {
    return { agentType, models: [], supported: false };
  }
  return unifiedSessions.listModels(agentType)
    .then((models) => ({ agentType, models }))
    .catch((err) => {
      if (err instanceof RuntimeSessionError && err.code === "OPERATION_NOT_SUPPORTED") {
        return { agentType, models: [], supported: false };
      }
      throw err;
    });
});

ipcMain.handle("agent:abort", (_event, sessionId?: string) => {
  return unifiedSessions.abort(sessionId);
});

// Resolve a pending ask_user question with the user's answer
ipcMain.handle("agent:answer-question", (_event, questionId: string, answer: string, selectedIndices?: number[]) => {
  return unifiedSessions.answerQuestion(questionId, { answer, selectedIndices });
});

/**
 * Steer additional user input into an already-running session without
 * interrupting the current agent loop. If the agent is not running,
 * the message is still saved but the handler starts a new run.
 */
ipcMain.handle("agent:steer", async (_event, input: string, sessionId: string, agentName?: string) => {
  const agentType = unifiedSessions.agentTypeFor(sessionId);
  if (agentType !== "customer-agent") {
    const isRunning = await unifiedSessions.steer(sessionId, input);
    if (!isRunning) {
      for await (const agentEvent of unifiedSessions.run(sessionId, input, [], undefined, agentName)) {
        mainWindow?.webContents.send("agent:event", { ...agentEvent, _sid: sessionId });
      }
    }
    return true;
  }
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
  return true;
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
  return unifiedSessions.list(projectId);
});

ipcMain.handle("workspaces:list", async (
  _event,
  agentType: AgentType,
  query?: import("./agent-runtime/types.js").WorkspaceQuery,
) => unifiedSessions.listWorkspaces(agentType, query));

ipcMain.handle("workspaces:import", async (
  _event,
  agentType: AgentType,
  path: string,
  name?: string,
) => {
  const canonicalPath = resolve(path.trim());
  if (!canonicalPath || !existsSync(canonicalPath) || !statSync(canonicalPath).isDirectory()) {
    throw new Error("请选择有效的文件夹");
  }
  if (agentType !== "customer-agent") {
    return unifiedSessions.importWorkspace(agentType, canonicalPath, name);
  }
  const projects = await agentHost.getProjectStore().list();
  const existing = projects.find((project) => resolve(project.description) === canonicalPath);
  const project = existing ?? await agentHost.getProjectStore().create({
    id: crypto.randomUUID(),
    name: name?.trim() || basename(canonicalPath) || canonicalPath,
    description: canonicalPath,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });
  return {
    workspace: {
      agentType,
      workspaceId: project.id,
      name: project.name,
      roots: [project.description],
      order: Math.max(0, projects.findIndex((candidate) => candidate.id === project.id)),
      updatedAt: project.updated,
      source: "native",
    },
    existing: Boolean(existing),
  };
});

ipcMain.handle("workspaces:listSessions", async (
  _event,
  agentType: AgentType,
  workspaceId: string,
  query?: import("./agent-runtime/types.js").WorkspaceSessionQuery,
) => unifiedSessions.listWorkspaceSessions(agentType, workspaceId, query));

ipcMain.handle("sessions:listChildren", async (_event, parentId: string) => {
  return unifiedSessions.listChildren(parentId);
});

ipcMain.handle("sessions:get", async (
  _event,
  id: string,
  query?: import("@agent/core").SessionHistoryQuery,
) => {
  const detail = await unifiedSessions.get(id, query);
  const deliveredCursor = {
    runId: detail.snapshotRunId ?? null,
    sequence: detail.snapshotRevision ?? 0,
  };
  if (detail.agentType !== "customer-agent") nativeDesktopCursors.set(id, deliveredCursor);
  if (detail.agentType !== "customer-agent" && detail.controller === "desktop") {
    void attachDesktopNativeEventForwarder(id, deliveredCursor).catch(() => undefined);
  }
  return detail;
});

ipcMain.handle("sessions:getToolResult", async (
  _event,
  id: string,
  ref: Pick<import("@agent/core").SessionToolResultRef, "turnId" | "itemId" | "revision">,
) => unifiedSessions.getSessionToolResult(id, ref));

ipcMain.handle("sessions:getQueryIndex", async (_event, id: string) => {
  return unifiedSessions.getQueryIndex(id);
});

ipcMain.handle("sessions:setPermissionMode", async (_event, id: string, mode: import("@agent/core").ToolPermissionMode) => {
  if (unifiedSessions.agentTypeFor(id) !== "customer-agent") {
    const session = await nativeRuntimeBroker.setPermissionMode(id, mode);
    unifiedSessions.invalidate(id);
    return session;
  }
  const session = await agentHost.setSessionPermissionMode(id, mode);
  unifiedSessions.invalidate(id);
  return session;
});

ipcMain.handle("sessions:getGoals", async (_event, id: string) => {
  if (unifiedSessions.agentTypeFor(id) === "customer-agent") {
    return customerGoalCoordinator.get(id);
  }
  const state = await nativeRuntimeBroker.getGoals(id, "desktop");
  await attachDesktopNativeEventForwarder(id).catch(() => undefined);
  return state;
});

ipcMain.handle("sessions:enqueueGoal", async (
  _event,
  id: string,
  objective: string,
  sourceMessageId?: string,
) => {
  if (unifiedSessions.agentTypeFor(id) === "customer-agent") {
    return customerGoalCoordinator.enqueue(id, objective, sourceMessageId);
  }
  const result = await nativeRuntimeBroker.enqueueGoal(id, objective, sourceMessageId, "desktop");
  await attachDesktopNativeEventForwarder(id).catch(() => undefined);
  return result.state;
});

ipcMain.handle("sessions:reorderGoals", async (_event, id: string, orderedIds: string[]) => {
  return unifiedSessions.agentTypeFor(id) === "customer-agent"
    ? customerGoalCoordinator.reorder(id, orderedIds)
    : nativeRuntimeBroker.reorderGoals(id, orderedIds);
});

ipcMain.handle("sessions:cancelGoal", async (_event, id: string, goalId: string) => {
  return unifiedSessions.agentTypeFor(id) === "customer-agent"
    ? customerGoalCoordinator.cancel(id, goalId)
    : nativeRuntimeBroker.cancelGoal(id, goalId, "desktop");
});

ipcMain.handle("sessions:enqueueMessage", async (
  _event,
  id: string,
  message: { sourceMessageId: string; content: string; images?: string[]; agentIds?: string[]; agentName?: string },
) => {
  if (unifiedSessions.agentTypeFor(id) === "customer-agent") {
    throw new Error("Durable message queue is only available for native sessions");
  }
  const result = await nativeRuntimeBroker.enqueueMessage(id, {
    sourceMessageId: message.sourceMessageId,
    content: message.content,
    messagePayload: {
      images: message.images,
      agentIds: message.agentIds,
      agentName: message.agentName,
    },
  }, "desktop");
  await attachDesktopNativeEventForwarder(id).catch(() => undefined);
  return result.state;
});

ipcMain.handle("sessions:updateMessage", async (_event, id: string, messageId: string, content: string) => {
  return nativeRuntimeBroker.updateMessage(id, messageId, content);
});

ipcMain.handle("sessions:reorderMessages", async (_event, id: string, orderedIds: string[]) => {
  return nativeRuntimeBroker.reorderMessages(id, orderedIds);
});

ipcMain.handle("sessions:cancelMessage", async (_event, id: string, messageId: string) => {
  return nativeRuntimeBroker.cancelMessage(id, messageId);
});

ipcMain.handle("sessions:steerMessage", async (_event, id: string, messageId: string) => {
  const result = await nativeRuntimeBroker.steerMessage(id, messageId);
  if (!result.steered) throw new Error("当前运行不支持插队消息");
  return result.state;
});

ipcMain.handle("sessions:handoff", async (_event, id: string) => {
  if (unifiedSessions.agentTypeFor(id) === "customer-agent") {
    throw new Error("Only native runtime sessions can be handed off");
  }
  const deliveredCursor = nativeDesktopCursors.get(id);
  const snapshot = await nativeRuntimeBroker.handoff(id, "desktop");
  await attachDesktopNativeEventForwarder(id, deliveredCursor);
  return snapshot;
});

ipcMain.handle("sessions:releaseCodex", async (_event, id: string) => {
  if (unifiedSessions.agentTypeFor(id) !== "codex") {
    throw new Error("Only Codex sessions can be released to the native client");
  }
  await nativeRuntimeBroker.release(id);
});

ipcMain.handle("sessions:create", async (
  _event,
  title: string,
  projectId?: string,
  agentType: AgentType = "customer-agent",
  cwd?: string,
) => {
  const project = projectId ? await agentHost.getProjectStore().get(projectId) : null;
  return unifiedSessions.create({
    title,
    projectId,
    agentType,
    cwd: cwd || project?.description || agentHost.getSettings().workingDirectory || desktopBaseDir,
  });
});

ipcMain.handle("sessions:fork", async (_event, id: string) => {
  return unifiedSessions.fork(id);
});

ipcMain.handle("sessions:delete", async (_event, id: string) => {
  await unifiedSessions.delete(id);
});

ipcMain.handle("sessions:refresh", async (_event, projectId?: string) => {
  return unifiedSessions.refresh(projectId);
});

ipcMain.handle("sessions:runtimeHealth", async () => {
  return unifiedSessions.health();
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
  if (process.platform === "darwin" && appIconPath) {
    const icon = nativeImage.createFromPath(appIconPath);
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  // Allow microphone access for voice input & wake-word listening
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  createWindow();
  void unifiedSessions.health();
  void connectVoiceProvider().then((provider) => {
    console.warn("[voice] provider ready:", provider.kind === "service" ? provider.source : "native");
  });
});

app.on("before-quit", () => {
  wakeDesired = false;
  dictationActive = false;
  cancelActiveTts();
  stopWakeProc();
  voiceServiceManager.close();
  void unifiedSessions.dispose();
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
