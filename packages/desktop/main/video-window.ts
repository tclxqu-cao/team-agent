import { createHash } from "node:crypto";
import type { FileWorkspacePreviewTicket } from "@agent/core";
import type { BrowserWindow } from "electron";
import type { DesktopFileWorkspaceService } from "./file-workspace-service.js";

export interface OpenVideoWindowOptions {
  source: string;
  remote: boolean;
  title: string;
  currentTime: number;
  playing: boolean;
}

const playerScript = String.raw`
  const video = document.querySelector("video");
  video.addEventListener("error", () => {
    video.hidden = true;
    document.querySelector("[role=status]").hidden = false;
  });
  video.addEventListener("loadedmetadata", () => {
    video.currentTime = Math.min(Number(video.dataset.time), video.duration || Infinity);
    if (video.dataset.playing === "true") void video.play().catch(() => {});
  }, { once: true });
  video.src = decodeURIComponent(video.dataset.source);
`;
const playerScriptHash = createHash("sha256").update(playerScript).digest("base64");

function videoWindowUrl(src: string, time: number, playing: boolean): string {
  const html = `<!doctype html>
    <html lang="zh-CN">
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; media-src agentroam-preview: http: https:; script-src 'sha256-${playerScriptHash}'; base-uri 'none'">
    <style>
      html, body, video { width: 100%; height: 100%; margin: 0; }
      body { background: #111; color: white; display: grid; place-items: center; font: 14px system-ui; }
      video { object-fit: contain; }
    </style>
    <video controls playsinline preload="metadata" aria-label="视频播放器"
      data-source="${encodeURIComponent(src)}" data-time="${time}" data-playing="${playing}"></video>
    <p role="status" hidden>媒体加载失败</p>
    <script>${playerScript}</script>
    </html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export async function openVideoWindow(
  Window: typeof BrowserWindow,
  files: Pick<DesktopFileWorkspaceService, "request">,
  raw: unknown,
  opener: BrowserWindow | null,
): Promise<void> {
  const options = raw as Partial<OpenVideoWindowOptions> | null;
  if (typeof options?.source !== "string" || !options.source || /[\0\r\n]/.test(options.source)
    || typeof options.title !== "string" || typeof options.remote !== "boolean") {
    throw new Error("视频来源无效");
  }
  const time = typeof options.currentTime === "number" && Number.isFinite(options.currentTime)
    ? Math.max(0, options.currentTime) : 0;
  const playing = options.playing === true;
  let src: string;
  let ticket: FileWorkspacePreviewTicket | undefined;
  const release = () => {
    if (ticket) void files.request("fs:preview-close", { ticketId: ticket.ticketId }).catch(() => {});
    ticket = undefined;
  };

  if (options.remote) {
    const url = new URL(options.source);
    if (!["http:", "https:"].includes(url.protocol) || !/\.(mp4|webm|mov|m4v)$/i.test(url.pathname)) {
      throw new Error("视频来源无效");
    }
    src = url.href;
  } else {
    // Keep the new window's local preview alive when the chat message unmounts.
    ticket = await files.request("fs:preview-open", { path: options.source }) as FileWorkspacePreviewTicket;
    if (!ticket.mime.startsWith("video/")) {
      release();
      throw new Error("此文件无法作为视频播放");
    }
    src = ticket.url;
  }

  let window: BrowserWindow | undefined;
  try {
    window = new Window({
      title: options.title.slice(0, 200) || "视频播放器",
      width: 840,
      height: 560,
      minWidth: 320,
      minHeight: 220,
      resizable: true,
      show: false,
      backgroundColor: "#111111",
      parent: opener && !opener.isDestroyed() && opener.isFullScreen() ? opener : undefined,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    window.once("closed", release);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.on("will-redirect", event => event.preventDefault());
    window.on("page-title-updated", event => event.preventDefault());
    await window.loadURL(videoWindowUrl(src, time, playing));
    if (!window.isDestroyed()) window.show();
  } catch (error) {
    if (window && !window.isDestroyed()) window.destroy();
    release();
    throw error;
  }
}
