import React from "react";
import { createRoot } from "react-dom/client";
import RemoteDesktopPage from "../../src/presentation/RemoteDesktopPage";
import { useUIStore } from "../../../desktop/renderer/stores/uiStore";
import "../../../desktop/renderer/styles/global.css";
import "../../src/presentation/web.css";

const calls: { method: string; params: any }[] = [];
const listeners = new Set<(event: any) => void>();
const viewport = { width: 1440, height: 900, deviceScaleFactor: 1 };
let session = { id: "regression-desktop", backend: "desktop", platform: "darwin", title: "Regression desktop", url: "", viewport, transport: "jpeg-ws", availability: "ready", state: "agent-controlled", online: true, frameSequence: 1, updatedAt: 1, viewerCount: 1, isController: false, controlledByAnotherViewer: false,
  displays: [{ id: "1", label: "第 1 屏", primary: true, selected: true }, { id: "2", label: "第 2 屏", primary: false, selected: false }],
  audioCapabilities: { fullDuplex: true, systemAudio: true, microphonePlayback: true, selfPlaybackExclusion: true },
};
const canvas = document.createElement("canvas");
canvas.width = 1440; canvas.height = 900;
const ctx = canvas.getContext("2d")!;
ctx.fillStyle = "#19283c"; ctx.fillRect(0, 0, 1440, 900);
ctx.fillStyle = "white"; ctx.fillRect(400, 300, 600, 80);
ctx.fillStyle = "black"; ctx.font = "28px sans-serif"; ctx.fillText("Password field fixture", 420, 350);
const frame = () => listeners.forEach(listener => listener({ type: "browser:frame", sessionId: session.id, sequence: 1, data: canvas.toDataURL("image/jpeg").split(",")[1], mime: "image/jpeg", viewport, timestamp: Date.now() }));
let hitDelay = 0;
let hit: any = { editable: true, bounds: { x: 400, y: 300, w: 600, h: 80 } };
(window as any).regression = {
  calls,
  setHit: (value: any) => { hit = value; },
  setHitDelay: (value: number) => { hitDelay = value; },
  visible: (visible: boolean) => window.postMessage({ type: "agent-web-shell:remote-desktop-visibility:v1", visible }, location.origin),
  frame,
  setSkin: (skin: "pearl" | "glass") => useUIStore.getState().setSkin(skin),
};
window.browserLiveApi = {
  request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "browser:list") return { sessions: [session] };
    if (method === "browser:takeover") { session = { ...session, state: "user-controlled", isController: true }; return { session }; }
    if (method === "browser:watch") { setTimeout(frame, 50); return { session }; }
    if (method === "browser:input") {
      const reply = { input: hit };
      if (hitDelay) await new Promise(resolve => setTimeout(resolve, hitDelay));
      return reply;
    }
    if (method === "browser:unwatch") return {};
    return {};
  },
  onEvent: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); },
} as any;
createRoot(document.getElementById("root")!).render(<RemoteDesktopPage />);
setTimeout(() => (window as any).regression.visible(true), 100);
