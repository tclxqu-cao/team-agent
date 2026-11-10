import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (_event: unknown, data: unknown) => void>();
  const windows: any[] = [];
  class BrowserWindow {
    destroyed = false;
    listeners = new Map<string, () => void>();
    webContents = { send: vi.fn() };
    constructor(_options: unknown) { windows.push(this); }
    isDestroyed() { return this.destroyed; }
    on(name: string, listener: () => void) { this.listeners.set(name, listener); }
    async loadFile(_path: string) {}
    close() { this.destroyed = true; this.listeners.get("closed")?.(); }
  }
  return { handlers, windows, BrowserWindow, ipcMain: { on: vi.fn((name: string, handler: any) => handlers.set(name, handler)) } };
});

vi.mock("@agent/core", async original => ({ ...await original<Record<string, unknown>>(), ...await import("../../core/src/domain/live-view/index.js") }));

vi.mock("electron", () => ({ BrowserWindow: electron.BrowserWindow, ipcMain: electron.ipcMain }));

import { defaultWebrtcCapturePagePath, WebrtcLive } from "./webrtc-live.js";

describe("WebrtcLive browser policy bridge", () => {
  beforeEach(() => {
    electron.windows.length = 0;
    electron.handlers.clear();
    electron.ipcMain.on.mockClear();
  });

  it("forwards receiver sizing through Core and includes dimension changes in tuning deduplication", async () => {
    let now = 0;
    const live = new WebrtcLive({ capturePagePath: () => "/capture.html", preloadPath: () => "/preload.cjs",
      sendToViewer: vi.fn(async () => undefined), setStandby: vi.fn(), now: () => now });
    try {
      live.handleViewerSignal({ kind: "start" });
      await vi.waitFor(() => expect(electron.windows).toHaveLength(1));
      const window = electron.windows[0];
      const handler = electron.handlers.get("webrtc-live:signal")!;
      handler(null, { kind: "state", state: "connected" });
      live.handleViewerSignal({ kind: "quality", quality: "hd" });
      const receiver = { sequence: 1, visible: true, width: 2560, height: 1440,
        viewport: { width: 390, height: 700, pixelRatio: 3, zoom: 1 } };
      live.handleViewerSignal({ kind: "stats", receiver });
      expect(window.webContents.send).toHaveBeenLastCalledWith("webrtc-live:signal", expect.objectContaining({ decision: expect.objectContaining({ maxEdge: 1280 }) }));
      now = 6000;
      live.handleViewerSignal({ kind: "stats", receiver: { ...receiver, sequence: 2, viewport: { ...receiver.viewport, zoom: 2 } } });
      expect(window.webContents.send).toHaveBeenLastCalledWith("webrtc-live:signal", expect.objectContaining({ decision: expect.objectContaining({ maxEdge: 2560 }) }));
    } finally { live.stop(); }
  });

  it("maps sender capabilities to High and recreates the peer once for Baseline", async () => {
    const sendToViewer = vi.fn(async () => undefined);
    const live = new WebrtcLive({
      capturePagePath: () => "/capture.html", preloadPath: () => "/preload.cjs",
      captureSize: () => ({ width: 2560, height: 1440 }), sendToViewer, setStandby: vi.fn(),
    });
    live.handleViewerSignal({ kind: "start", receiverProfiles: ["high", "baseline"] });
    await vi.waitFor(() => expect(electron.windows).toHaveLength(1));
    const window = electron.windows[0];
    await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledWith(
      "webrtc-live:signal", { kind: "start", captureSize: { width: 2560, height: 1440 } },
    ));
    const handler = electron.handlers.get("webrtc-live:signal")!;
    handler(null, { kind: "sender-capabilities", profiles: ["high", "baseline"] });
    await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledWith(
      "webrtc-live:signal", expect.objectContaining({ kind: "configure", decision: expect.objectContaining({ preferredCodec: "high" }) }),
    ));
    handler(null, { kind: "profile-failed", profile: "high" });
    await vi.waitFor(() => expect(electron.windows).toHaveLength(2));
    const fallbackWindow = electron.windows[1];
    handler(null, { kind: "sender-capabilities", profiles: ["high", "baseline"] });
    await vi.waitFor(() => expect(fallbackWindow.webContents.send).toHaveBeenCalledWith(
      "webrtc-live:signal", expect.objectContaining({ kind: "configure", decision: expect.objectContaining({ preferredCodec: "baseline" }) }),
    ));
    live.stop();
  });

  it("falls back after a connected High stream produces no encoded frame", async () => {
    vi.useFakeTimers();
    const sendToViewer = vi.fn(async () => undefined);
    const live = new WebrtcLive({ capturePagePath: () => "/capture.html", preloadPath: () => "/preload.cjs", sendToViewer, setStandby: vi.fn() });
    try {
      live.handleViewerSignal({ kind: "start", receiverProfiles: ["high", "baseline"] });
      await vi.advanceTimersByTimeAsync(0);
      const handler = electron.handlers.get("webrtc-live:signal")!;
      handler(null, { kind: "sender-capabilities", profiles: ["high", "baseline"] });
      handler(null, { kind: "state", state: "connected" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(electron.windows).toHaveLength(2);
    } finally {
      live.stop();
      vi.useRealTimers();
    }
  });

  it("turns an unavailable Baseline profile into a terminal producer state", async () => {
    const sendToViewer = vi.fn(async () => undefined);
    const live = new WebrtcLive({ capturePagePath: () => "/capture.html", preloadPath: () => "/preload.cjs", sendToViewer, setStandby: vi.fn() });
    live.handleViewerSignal({ kind: "start", receiverProfiles: ["baseline"] });
    await vi.waitFor(() => expect(electron.windows).toHaveLength(1));
    const handler = electron.handlers.get("webrtc-live:signal")!;
    handler(null, { kind: "sender-capabilities", profiles: ["baseline"] });
    handler(null, { kind: "profile-failed", profile: "baseline" });
    await vi.waitFor(() => expect(sendToViewer).toHaveBeenCalledWith(expect.objectContaining({ kind: "state", state: "failed" })));
    expect(sendToViewer).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "profile-failed" }));
    live.stop();
  });

  it("applies normalized sender observations without relaying internal messages", async () => {
    const sendToViewer = vi.fn(async () => undefined);
    const live = new WebrtcLive({ capturePagePath: () => "/capture.html", preloadPath: () => "/preload.cjs", sendToViewer, setStandby: vi.fn() });
    live.handleViewerSignal({ kind: "start", receiverProfiles: ["baseline"] });
    await vi.waitFor(() => expect(electron.windows).toHaveLength(1));
    const handler = electron.handlers.get("webrtc-live:signal")!;
    handler(null, { kind: "sender-capabilities", profiles: ["baseline"] });
    handler(null, { kind: "sender-stats", observation: { encoder: { encodeLatencyMs: 100, sampledAt: 1 } } });
    await vi.waitFor(() => expect(electron.windows[0].webContents.send).toHaveBeenCalledWith(
      "webrtc-live:signal", expect.objectContaining({ kind: "tuning", decision: expect.objectContaining({ reason: "encoder-pressure" }) }),
    ));
    expect(sendToViewer).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "sender-stats" }));
    live.stop();
  });

  it("resolves packaged and development capture page paths", () => {
    expect(defaultWebrtcCapturePagePath("/repo/packages/desktop/dist/main", false, "/Resources")).toBe("/repo/packages/desktop/assets/webrtc-live.html");
    expect(defaultWebrtcCapturePagePath("/dist/main", true, "/Resources")).toBe("/Resources/assets/webrtc-live.html");
  });

  it("keeps Retina screen capture scaled to logical pixels while tuning frame rate", () => {
    const capturePage = readFileSync(new URL("../assets/webrtc-live.html", import.meta.url), "utf8");
    expect(capturePage).toContain("requestedCaptureSize?.width");
    expect(capturePage).toContain('resizeMode: "crop-and-scale"');
    expect(capturePage).toContain("width: { ideal: captureSize.width, max: captureSize.width }");
    expect(capturePage).toContain("height: { ideal: captureSize.height, max: captureSize.height }");
  });
});
