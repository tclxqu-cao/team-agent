import type { DictationPort } from "../../domain/ports/dictation-port";
import { PcmResampler } from "./pcm-resampler";

type Result = { text: string; isFinal: boolean };
type Capture = {
  state: "starting" | "capturing" | "draining";
  sessionId: string;
  generation: number;
  committed: string;
  interim: string;
  utterances: Set<number>;
  context?: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  node?: AudioNode;
  clearProcessor?: () => void;
  socket?: WebSocket;
  ready?: () => void;
  rejectReady?: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  startupTimer?: ReturnType<typeof setTimeout>;
  cancelStartup?: () => void;
  flushAudio?: () => Promise<void>;
  cancelFlush?: () => void;
  stopped?: Promise<void>;
  resolveStopped?: () => void;
  microphoneReleased?: boolean;
};

interface DictationEnvironment {
  openSocket: () => Promise<WebSocket>;
  getUserMedia?: () => Promise<MediaStream>;
  createContext?: () => AudioContext;
  createWorklet?: (context: AudioContext) => AudioWorkletNode;
}

/** Browser capture adapter for the same dictation port used by Electron. */
export class BrowserDictation implements DictationPort {
  private active: Capture | null = null;
  private generation = 0;
  private readonly results = new Set<(result: Result) => void>();
  private readonly errors = new Set<(message: string) => void>();

  constructor(private readonly environment: DictationEnvironment) {
    window.addEventListener("pagehide", () => this.complete(this.active));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.complete(this.active);
    });
  }

  onDictation(callback: (result: Result) => void): () => void {
    this.results.add(callback);
    return () => { this.results.delete(callback); };
  }

  onDictationError(callback: (message: string) => void): () => void {
    this.errors.add(callback);
    return () => { this.errors.delete(callback); };
  }

  async dictationStart(): Promise<{ ok: boolean; reason?: string }> {
    if (this.active) return { ok: false, reason: "语音输入尚未结束" };
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return { ok: false, reason: "语音输入需要 HTTPS 地址和麦克风权限" };
    }
    const capture: Capture = {
      state: "starting",
      sessionId: crypto.randomUUID(), generation: ++this.generation,
      committed: "", interim: "", utterances: new Set(),
    };
    this.active = capture;
    try {
      // Create/resume audio and request the mic inside the original tap gesture (Safari).
      const context = this.environment.createContext?.() ?? new AudioContext();
      capture.context = context;
      const media = (this.environment.getUserMedia?.() ?? navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })).then((stream) => {
        if (this.active !== capture) {
          for (const track of stream.getTracks()) track.stop();
          throw new Error("语音输入已取消");
        }
        capture.stream = stream;
      });
      const startup = Promise.all([
        media, this.connect(capture),
        context.resume().then(() => this.prepareProcessor(capture)),
      ]);
      await Promise.race([
        startup,
        new Promise<void>((resolve) => { capture.cancelStartup = resolve; }),
        new Promise<never>((_resolve, reject) => {
          capture.startupTimer = setTimeout(() => reject(new Error("麦克风启动超时，请检查权限后重试")), 10_000);
        }),
      ]);
      clearTimeout(capture.startupTimer);
      if (this.active !== capture) return { ok: false };
      capture.source = context.createMediaStreamSource(capture.stream!);
      capture.source.connect(capture.node!);
      // Both capture processors emit silence; microphone audio is never played.
      capture.node!.connect(context.destination);
      capture.state = "capturing";
      return { ok: true };
    } catch (error) {
      if (this.active !== capture) return { ok: false };
      const reason = error instanceof Error && error.name === "NotAllowedError"
        ? "麦克风权限未开启，请在浏览器网站设置中允许麦克风"
        : error instanceof Error ? error.message : "无法启动语音输入";
      this.release(capture);
      return { ok: false, reason };
    }
  }

  async dictationStop(): Promise<{ ok: boolean }> {
    const capture = this.active;
    if (!capture) return { ok: true };
    if (capture.state === "starting") {
      this.complete(capture);
      return { ok: true };
    }
    if (capture.state === "draining") {
      await capture.stopped;
      return { ok: true };
    }
    capture.state = "draining";
    capture.stopped = new Promise((resolve) => { capture.resolveStopped = resolve; });
    // Stop collecting immediately, but retain the transport for the final result.
    for (const track of capture.stream?.getTracks() ?? []) track.stop();
    capture.source?.disconnect();
    clearTimeout(capture.timer);
    capture.timer = setTimeout(() => this.fail(capture, "语音识别收尾超时，已保留当前文字"), 12_000);
    try {
      await capture.flushAudio?.();
      this.releaseMicrophone(capture);
      if (this.active === capture) {
        capture.socket!.send(JSON.stringify({ type: "finish", sessionId: capture.sessionId, generation: capture.generation }));
      }
    } catch {
      this.fail(capture, "语音输入收尾失败，已保留当前文字");
    }
    await capture.stopped;
    return { ok: true };
  }

  private async prepareProcessor(capture: Capture): Promise<void> {
    const context = capture.context!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Some embedded browsers expose AudioWorklet but never settle addModule.
    // Keep capture usable there with the browser's main-thread audio callback.
    const workletReady = context.audioWorklet && await Promise.race([
      context.audioWorklet.addModule(new URL("./dictation-audio-worklet.js", location.href).href).then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1_500); }),
    ]);
    clearTimeout(timer);
    if (this.active !== capture) return;
    if (workletReady) {
      const node = this.environment.createWorklet?.(context) ?? new AudioWorkletNode(context, "dictation-capture");
      capture.node = node;
      let flushed: (() => void) | undefined;
      node.port.onmessage = ({ data }) => {
        if (this.active !== capture) return;
        if (data.type === "pcm" && data.pcm instanceof ArrayBuffer) this.sendPcm(capture, data.pcm);
        if (data.type === "flushed") flushed?.();
      };
      capture.flushAudio = () => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Audio flush timed out")), 500);
        flushed = () => { clearTimeout(timer); resolve(); };
        capture.cancelFlush = flushed;
        node.port.postMessage({ type: "flush" });
      });
      node.onprocessorerror = () => this.fail(capture, "麦克风音频处理失败，请重新开始");
      capture.clearProcessor = () => { node.port.onmessage = null; node.onprocessorerror = null; };
      return;
    }
    const node = context.createScriptProcessor(2048, 1, 1);
    const resampler = new PcmResampler(context.sampleRate, (pcm) => this.sendPcm(capture, pcm));
    node.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0);
      resampler.push([event.inputBuffer.getChannelData(0)]);
    };
    capture.node = node;
    capture.flushAudio = async () => { node.onaudioprocess = null; resampler.flush(); };
    capture.clearProcessor = () => { node.onaudioprocess = null; };
  }

  private sendPcm(capture: Capture, pcm: ArrayBuffer): void {
    if (this.active !== capture) return;
    if (capture.socket?.readyState !== WebSocket.OPEN) { this.fail(capture, "语音连接已断开"); return; }
    if (capture.socket.bufferedAmount > 128 * 1024) { this.fail(capture, "网络过慢，语音输入已停止"); return; }
    capture.socket.send(pcm);
  }

  private async connect(capture: Capture): Promise<void> {
    const socket = await this.environment.openSocket();
    if (this.active !== capture) { socket.close(); return; }
    capture.socket = socket;
    return new Promise<void>((resolve, reject) => {
      capture.ready = resolve;
      capture.rejectReady = reject;
      capture.timer = setTimeout(() => reject(new Error("本机语音服务连接超时")), 8_000);
      const start = () => socket.send(JSON.stringify({ type: "start", mode: "dictation", sampleRate: 16_000, sessionId: capture.sessionId, generation: capture.generation }));
      socket.addEventListener("open", start, { once: true });
      socket.addEventListener("message", ({ data }) => {
        if (this.active !== capture) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(String(data)) as Record<string, unknown>; }
        catch { this.fail(capture, "语音服务返回无效数据"); return; }
        if (event.type === "error") { this.fail(capture, typeof event.message === "string" ? event.message : "语音识别失败"); return; }
        if (event.sessionId !== capture.sessionId || event.generation !== capture.generation) return;
        if (event.type === "ready") { clearTimeout(capture.timer); resolve(); return; }
        if ((event.type === "partial" || event.type === "final") && typeof event.text === "string") {
          if (event.type === "partial") capture.interim = event.text;
          else if (Number.isSafeInteger(event.utteranceId) && !capture.utterances.has(Number(event.utteranceId))) {
            capture.utterances.add(Number(event.utteranceId));
            capture.committed = this.join(capture.committed, event.text);
            capture.interim = "";
          }
          this.emit({ text: this.join(capture.committed, capture.interim), isFinal: false });
        }
        if (event.type === "finished") this.complete(capture);
      });
      const disconnected = () => this.fail(capture, "语音连接已断开，已保留当前文字");
      socket.addEventListener("error", disconnected);
      socket.addEventListener("close", disconnected);
      if (socket.readyState === WebSocket.OPEN) start();
    });
  }

  private join(prefix: string, suffix: string): string {
    return prefix + (/[a-z0-9]$/i.test(prefix) && /^[a-z0-9]/i.test(suffix) ? " " : "") + suffix;
  }

  private emit(result: Result): void { for (const callback of this.results) callback(result); }

  private complete(capture: Capture | null): void {
    if (!capture || this.active !== capture) return;
    const text = this.join(capture.committed, capture.interim);
    this.release(capture);
    this.emit({ text, isFinal: true });
  }

  private fail(capture: Capture, message: string): void {
    if (this.active !== capture) return;
    capture.rejectReady?.(new Error(message));
    this.release(capture);
    for (const callback of this.errors) callback(message);
  }

  private releaseMicrophone(capture: Capture): void {
    if (capture.microphoneReleased) return;
    capture.microphoneReleased = true;
    if (capture.state !== "draining") for (const track of capture.stream?.getTracks() ?? []) track.stop();
    capture.clearProcessor?.();
    capture.source?.disconnect();
    capture.node?.disconnect();
    void capture.context?.close().catch(() => undefined);
  }

  private release(capture: Capture): void {
    if (this.active === capture) this.active = null;
    clearTimeout(capture.timer);
    clearTimeout(capture.startupTimer);
    capture.cancelStartup?.();
    capture.cancelFlush?.();
    capture.resolveStopped?.();
    capture.ready?.();
    this.releaseMicrophone(capture);
    capture.socket?.close();
  }
}
