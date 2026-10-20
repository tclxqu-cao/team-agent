import { afterEach, describe, expect, it, vi } from "vitest";
import { startDictation } from "../../../../desktop/renderer/lib/speech";
import { BrowserDictation } from "./browser-dictation";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | ArrayBuffer> = [];
  control: Record<string, unknown> = {};
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    if (typeof data !== "string") return;
    const control = JSON.parse(data);
    if (control.type === "start") {
      this.control = control;
      queueMicrotask(() => this.receive({ type: "ready" }));
    }
  }
  receive(event: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...this.control, ...event }) }));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture() {
  const window = Object.assign(new EventTarget(), { isSecureContext: true });
  const document = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("location", { href: "https://example.test/app/" });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal("WebSocket", FakeSocket);
  let socket = new FakeSocket();
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  const context = {
    sampleRate: 48_000,
    resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    destination: {},
    createScriptProcessor: vi.fn(() => scriptNode),
  };
  const scriptNode = { onaudioprocess: null as null | ((event: { inputBuffer: { getChannelData: () => Float32Array }; outputBuffer: { getChannelData: () => Float32Array } }) => void), connect: vi.fn(), disconnect: vi.fn() };
  const node = {
    port: { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: vi.fn() },
    connect: vi.fn(), disconnect: vi.fn(),
  };
  const dictation = new BrowserDictation({
    openSocket: async () => {
      if (socket.readyState === 3) socket = new FakeSocket();
      return socket as unknown as WebSocket;
    },
    getUserMedia,
    createContext: () => context as unknown as AudioContext,
    createWorklet: () => node as unknown as AudioWorkletNode,
  });
  const results: Array<{ text: string; isFinal: boolean }> = [];
  const errors: string[] = [];
  dictation.onDictation((result) => results.push(result));
  dictation.onDictationError((error) => errors.push(error));
  return { dictation, get socket() { return socket; }, results, errors, stopTrack, context, node, scriptNode, getUserMedia, stream, window, document };
}

describe("browser dictation lifecycle", () => {
  it("loads the audio worklet only after the context finishes resuming", async () => {
    const f = fixture();
    let resume!: () => void;
    f.context.resume.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve; }));
    const starting = f.dictation.dictationStart();
    await Promise.resolve();
    expect(f.context.audioWorklet.addModule).not.toHaveBeenCalled();
    resume();
    expect(await starting).toEqual({ ok: true });
    f.window.dispatchEvent(new Event("pagehide"));
  });

  it("times out stalled audio initialization and releases the microphone", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.context.resume.mockImplementationOnce(() => new Promise(() => undefined));
    const starting = f.dictation.dictationStart();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await starting).toEqual({ ok: false, reason: expect.stringContaining("启动超时") });
    expect(f.stopTrack).toHaveBeenCalled();
  });

  it("flushes the remaining PCM before finish when worklet loading stalls", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let load!: () => void;
    f.context.audioWorklet.addModule.mockImplementationOnce(() => new Promise((resolve) => { load = resolve; }));
    const starting = f.dictation.dictationStart();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await starting).toEqual({ ok: true });
    const output = new Float32Array(2048).fill(1);
    for (let i = 0; i < 3; i++) {
      f.scriptNode.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.25) }, outputBuffer: { getChannelData: () => output } });
    }
    load();
    await Promise.resolve();
    const stopping = f.dictation.dictationStop();
    await Promise.resolve();
    const frames = f.socket.sent.filter((data): data is ArrayBuffer => data instanceof ArrayBuffer);
    expect(frames).toHaveLength(2);
    expect(new Float32Array(frames[0])).toHaveLength(1600);
    expect(new Float32Array(frames[1])).toHaveLength(448);
    expect(JSON.parse(f.socket.sent.at(-1) as string).type).toBe("finish");
    expect(output.every((value) => value === 0)).toBe(true);
    expect(f.scriptNode.onaudioprocess).toBeNull();
    expect(f.stopTrack).toHaveBeenCalled();
    expect(f.results).toEqual([]);
    f.socket.receive({ type: "finished" });
    await stopping;
    expect(f.results.at(-1)).toEqual({ text: "", isFinal: true });
  });

  it("settles cancellation while audio resume remains pending", async () => {
    const f = fixture();
    f.context.resume.mockImplementationOnce(() => new Promise(() => undefined));
    const starting = f.dictation.dictationStart();
    await f.dictation.dictationStop();
    expect(await starting).toEqual({ ok: false });
  });

  it("stops the mic immediately and waits for flushed audio and the server final", async () => {
    const f = fixture();
    expect(await f.dictation.dictationStart()).toEqual({ ok: true });
    f.socket.receive({ type: "final", utteranceId: 1, text: "打开项目" });
    f.socket.receive({ type: "final", utteranceId: 1, text: "打开项目" });
    f.socket.receive({ type: "partial", text: "检查" });
    expect(f.results.at(-1)).toEqual({ text: "打开项目检查", isFinal: false });
    const stopping = f.dictation.dictationStop();
    expect(f.results.at(-1)).toEqual({ text: "打开项目检查", isFinal: false });
    expect(f.stopTrack).toHaveBeenCalledOnce();
    expect(f.node.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
    expect(f.socket.readyState).toBe(1);
    expect(f.socket.sent.some((data) => typeof data === "string" && JSON.parse(data).type === "finish")).toBe(false);
    f.node.port.onmessage!({ data: { type: "pcm", pcm: new Float32Array(10).buffer } });
    f.node.port.onmessage!({ data: { type: "flushed" } });
    await Promise.resolve();
    expect(JSON.parse(f.socket.sent.at(-1) as string).type).toBe("finish");
    f.socket.receive({ type: "final", utteranceId: 2, text: "检查代码" });
    f.socket.receive({ type: "finished" });
    expect(f.results.at(-1)).toEqual({ text: "打开项目检查代码", isFinal: true });
    expect(f.socket.readyState).toBe(3);
    expect(await stopping).toEqual({ ok: true });
  });

  it("allows restart after finished and isolates late events from the previous capture", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.dictation.dictationStart();
    f.context.close.mockImplementationOnce(() => new Promise(() => undefined));
    f.socket.receive({ type: "partial", text: "第一段" });
    const oldSocket = f.socket;
    const stopping = f.dictation.dictationStop();
    expect(await f.dictation.dictationStart()).toEqual({ ok: false, reason: "语音输入尚未结束" });
    f.node.port.onmessage!({ data: { type: "flushed" } });
    await Promise.resolve();
    oldSocket.receive({ type: "finished" });
    await stopping;
    const restarting = f.dictation.dictationStart();
    expect(await restarting).toEqual({ ok: true });
    expect(f.socket).not.toBe(oldSocket);
    oldSocket.receive({ type: "final", utteranceId: 1, text: "旧的补充文字" });
    oldSocket.receive({ type: "error", message: "旧连接错误" });
    oldSocket.receive({ type: "finished" });
    f.socket.receive({ type: "partial", text: "第二段" });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(f.results).toEqual([
      { text: "第一段", isFinal: false },
      { text: "第一段", isFinal: true },
      { text: "第二段", isFinal: false },
    ]);
    expect(f.errors).toEqual([]);
    expect(f.stopTrack).toHaveBeenCalledOnce();
    expect(await stopping).toEqual({ ok: true });
    const secondStop = f.dictation.dictationStop();
    f.node.port.onmessage!({ data: { type: "flushed" } });
    await Promise.resolve();
    f.socket.receive({ type: "finished" });
    await secondStop;
    expect(f.results.at(-1)).toEqual({ text: "第二段", isFinal: true });
  });

  it("settles the shared composer with the final result and preserves later manual edits", async () => {
    const f = fixture();
    Object.assign(f.window, { agentApi: f.dictation });
    const onEnd = vi.fn();
    let text = "";
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const handle = startDictation({
      onStart: started,
      onInterim: (value) => { text = value; },
      onFinal: (value) => { text = value; },
      onEnd,
    });
    await ready;
    f.socket.receive({ type: "partial", text: "已识别文字" });
    handle!.stop();
    expect(onEnd).not.toHaveBeenCalled();
    expect(f.stopTrack).toHaveBeenCalledOnce();
    expect(text).toBe("已识别文字");
    f.node.port.onmessage!({ data: { type: "flushed" } });
    await Promise.resolve();
    f.socket.receive({ type: "final", utteranceId: 1, text: "迟到的识别结果" });
    f.socket.receive({ type: "finished" });
    expect(text).toBe("迟到的识别结果");
    text += "，继续手动编辑";
    f.socket.receive({ type: "final", utteranceId: 2, text: "旧连接文字" });
    expect(text).toBe("迟到的识别结果，继续手动编辑");
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("ends empty speech without requiring nonempty transcript text", async () => {
    const f = fixture();
    await f.dictation.dictationStart();
    const stopping = f.dictation.dictationStop();
    f.node.port.onmessage!({ data: { type: "flushed" } });
    await Promise.resolve();
    f.socket.receive({ type: "finished" });
    await stopping;
    expect(f.results).toEqual([{ text: "", isFinal: true }]);
    expect(await f.dictation.dictationStart()).toEqual({ ok: true });
    f.window.dispatchEvent(new Event("pagehide"));
  });

  it("releases a stuck flush or final result without leaving the composer locked", async () => {
    vi.useFakeTimers();
    for (const flushes of [false, true]) {
      const f = fixture();
      await f.dictation.dictationStart();
      f.socket.receive({ type: "partial", text: "已保留文字" });
      const stopping = f.dictation.dictationStop();
      if (flushes) f.node.port.onmessage!({ data: { type: "flushed" } });
      await vi.advanceTimersByTimeAsync(12_000);
      await stopping;
      expect(f.errors).toHaveLength(1);
      expect(f.socket.readyState).toBe(3);
      expect(f.results.at(-1)?.text).toBe("已保留文字");
      expect(f.stopTrack).toHaveBeenCalledOnce();
    }
  });

  it("releases media that resolves after the user cancels startup", async () => {
    const f = fixture();
    let resolveMedia!: (stream: MediaStream) => void;
    f.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { resolveMedia = resolve; }));
    const starting = f.dictation.dictationStart();
    await f.dictation.dictationStop();
    resolveMedia(f.stream);
    expect(await starting).toEqual({ ok: false });
    expect(f.stopTrack).toHaveBeenCalledOnce();
    expect(f.results.at(-1)?.isFinal).toBe(true);
  });

  it("reports service failures and releases microphone resources", async () => {
    const f = fixture();
    await f.dictation.dictationStart();
    f.socket.receive({ type: "partial", text: "保留文字" });
    f.socket.close();
    expect(f.errors).toEqual(["语音连接已断开，已保留当前文字"]);
    expect(f.stopTrack).toHaveBeenCalled();
    expect(f.results.at(-1)?.text).toBe("保留文字");
  });

  it("releases microphone on backgrounding and ignores stale generation events", async () => {
    const f = fixture();
    await f.dictation.dictationStart();
    f.socket.receive({ type: "partial", text: "旧会话", generation: 0 });
    expect(f.results).toEqual([]);
    f.document.hidden = true;
    f.document.dispatchEvent(new Event("visibilitychange"));
    expect(f.stopTrack).toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({ text: "", isFinal: true });
  });

  it("returns a useful microphone permission error", async () => {
    const f = fixture();
    f.getUserMedia.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    expect(await f.dictation.dictationStart()).toEqual({ ok: false, reason: expect.stringContaining("麦克风权限") });
    expect(f.context.close).toHaveBeenCalled();
  });
});
