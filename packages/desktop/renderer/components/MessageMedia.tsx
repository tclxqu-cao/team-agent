import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Maximize } from "lucide-react";
import { resolveMessageMediaPath } from "../lib/message-media";
import type { FileWorkspacePreviewTicket } from "../../../core/src/domain/file-workspace/entities";
import { isWebMediaUrl } from "../../../core/src/domain/web-console/WebArtifactBridge";
import MessageImageLightbox from "./MessageImageLightbox";

export const MessageMediaWorkspace = createContext<string | null>(null);

interface MessageMediaProps {
  path: string;
  label: string;
  kind: "image" | "video";
  onOpenArtifact?: (path: string) => void;
}

export default function MessageMedia({ path, label, kind, onOpenArtifact }: MessageMediaProps) {
  const workspacePath = useContext(MessageMediaWorkspace);
  const resolvedPath = resolveMessageMediaPath(path, workspacePath);
  const remote = isWebMediaUrl(path);
  const [source, setSource] = useState<{ path: string; url: string } | null>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openingVideo, setOpeningVideo] = useState(false);
  const [videoWindowError, setVideoWindowError] = useState<string | null>(null);
  const container = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canPopOutVideo = kind === "video" && typeof window !== "undefined"
    && Boolean(window.agentApi?.openVideoWindow);
  const src = remote ? path : source?.path === path ? source.url : null;
  const name = label && label !== path ? label.replace(/^`|`$/g, "") : path.split(/[\\/]/).pop() || "媒体";

  useEffect(() => {
    setExpanded(false);
    setFailedPath(null);
    setVideoWindowError(null);
    if (remote) return;
    const api = window.agentApi;
    let disposed = false;
    let started = false;
    let ticketId: string | null = null;
    const close = (ticket: string) => { void api.fileWorkspaceRequest("fs:preview-close", { ticketId: ticket }).catch(() => {}); };
    const load = () => {
      if (started || disposed) return;
      started = true;
      if (!api?.fileWorkspaceRequest || !resolvedPath) { setFailedPath(path); return; }
      void api.fileWorkspaceRequest<FileWorkspacePreviewTicket>("fs:preview-open", { path: resolvedPath }).then((ticket) => {
        if (disposed) { close(ticket.ticketId); return; }
        ticketId = ticket.ticketId;
        setSource({ path, url: ticket.url });
      }).catch(() => { if (!disposed) setFailedPath(path); });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); load(); }
    }, { rootMargin: "300px" });
    if (observer && container.current) observer.observe(container.current);
    else load();
    return () => { disposed = true; observer?.disconnect(); if (ticketId) close(ticketId); };
  }, [path, remote, resolvedPath]);

  const popOutVideo = async () => {
    const player = video.current;
    const sourcePath = remote ? path : resolvedPath;
    if (!player || !sourcePath || openingVideo) return;
    setOpeningVideo(true);
    setVideoWindowError(null);
    const playing = !player.paused && !player.ended;
    player.pause();
    try {
      await window.agentApi.openVideoWindow!({
        source: sourcePath,
        remote,
        title: name,
        currentTime: player.currentTime,
        playing,
      });
    } catch {
      setVideoWindowError(path);
      if (playing && video.current === player) void player.play().catch(() => {});
    } finally {
      setOpeningVideo(false);
    }
  };

  return <span ref={container} className="chat-message-media" data-tab-swipe-ignore>
    {failedPath === path ? <span role="status">媒体加载失败 {onOpenArtifact && resolvedPath && <button type="button" className="chat-message-artifact-link" onClick={() => onOpenArtifact(resolvedPath)}>打开预览</button>}</span>
      : !src ? <span role="status">正在加载{name}…</span>
        : kind === "video" ? <span className="chat-message-media__video">
            <video ref={video} src={src} controls controlsList={canPopOutVideo ? "nofullscreen" : undefined} playsInline preload="metadata" aria-label={name} onError={() => setFailedPath(path)} />
            {canPopOutVideo && <button type="button" className="chat-message-media__popout" aria-label="在独立窗口播放" title="在独立窗口播放" disabled={openingVideo} onClick={() => { void popOutVideo(); }}>
              <Maximize size={16} aria-hidden="true" />
            </button>}
            {videoWindowError === path && <span role="status">无法打开独立播放器，请重试</span>}
          </span>
          : <button type="button" className="chat-message-media__image" aria-label={`放大图片 ${name}`} onClick={() => setExpanded(true)}>
            <img src={src} alt={name} loading="lazy" onError={() => setFailedPath(path)} />
          </button>}
    <MessageImageLightbox image={expanded && src ? { src, alt: name } : null} onClose={() => setExpanded(false)} />
  </span>;
}
