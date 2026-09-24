"use client";
// FilePreview — routes by file type:
//   text    → progressive UTF-8 chunks driven by viewport demand
//   browser → sandboxed <iframe> using the file's original bytes and MIME
//   image   → <img> from a ticketed streaming URL
//   video   → <video controls>
//   audio   → <audio controls>
//   pdf     → <iframe>
//   other   → hex dump (first 4 KiB) — everything is viewable
// Auto-refreshes when the gateway reports the open file changed on disk.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Eye, LoaderCircle, Pencil, RefreshCw, RotateCcw, Save, Share2, X } from "lucide-react";
import type { FileWorkspaceGateway } from "../../../../core/src/application/file-workspace/FileWorkspaceGateway";
import { parseUnifiedDiff, type FileDiffRow } from "./fileDiff";

const TEXT_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "markdown", "mdown", "mkdn", "mdx", "css", "scss",
  "html", "htm", "xml", "yml", "yaml", "toml", "sh", "zsh", "bash", "py", "rb", "go",
  "rs", "java", "kt", "c", "h", "cpp", "hpp", "sql", "env", "gitignore",
  "dockerfile", "txt", "log", "conf", "properties", "gradle", "lock", "csv",
  "vue", "svelte", "astro", "graphql", "prisma", "proto",
]);
const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const HTML_EXTS = new Set(["html", "htm"]);
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkdn", "mdx"]);
const BROWSER_PREVIEW_EXTS = new Set(TEXT_EXTS);
// Mirrors the server's `HTML_PREVIEW_CSP`: unique opaque origin for the
// rendered deliverable — scripts run, console origin stays out of reach.
const HTML_IFRAME_SANDBOX = "allow-scripts allow-popups allow-forms allow-modals";
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"]);
const PDF_EXTS = new Set(["pdf"]);
const MAX_TEXT = 8 * 1024 * 1024;
const HEX_BYTES = 4096;
const DOWNLOAD_CHUNK_BYTES = 512 * 1024;
export const MAX_CLIENT_DOWNLOAD_BYTES = 256 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  aac: "audio/aac",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/mp4",
  m4v: "video/mp4",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  zip: "application/zip",
};

type Kind = "text" | "image" | "video" | "audio" | "pdf" | "hex" | "unsupported";
type PreviewPhase = "initial-loading" | "ready" | "loading-more" | "error";
type GatewayRpc = FileWorkspaceGateway["request"];

interface FsReadResult {
  data: string;
  bytes: number;
  offset: number;
  eof: boolean;
  size: number;
}

export interface NativeShareClient {
  canShare?: (data?: ShareData) => boolean;
  share?: (data?: ShareData) => Promise<void>;
}

export type NativeShareReadiness = "ready" | "insecure-context" | "unsupported-browser";
export type NativeShareOutcome = "shared" | "cancelled" | "unsupported";

export function nativeFileShareReadiness(
  client: NativeShareClient,
  isSecureContext: boolean,
): NativeShareReadiness {
  if (!isSecureContext) return "insecure-context";
  if (!client.share || !client.canShare) return "unsupported-browser";
  return "ready";
}

export function mimeTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export async function shareFileWithNativePicker(
  file: File,
  client: NativeShareClient,
): Promise<NativeShareOutcome> {
  if (!client.share || !client.canShare?.({ files: [file] })) return "unsupported";
  try {
    await client.share({ files: [file], title: file.name });
    return "shared";
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      return "cancelled";
    }
    throw error;
  }
}

interface TextInspectionResult {
  tooLarge: boolean;
  data: string | null;
  size: number;
  mtime: number;
  diffStatus: "changed" | "unchanged" | "untracked" | "unavailable";
  patch: string | null;
  validUtf8: boolean;
}

interface TextStatusResult {
  tooLarge: boolean;
  size: number;
  mtime: number;
  diffStatus: TextInspectionResult["diffStatus"];
}

interface MediaPreviewResult {
  ticketId: string;
  url: string;
  size: number;
  mtime: number;
  mime: string;
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

export function decodeTextChunk(decoder: TextDecoder, data: string, eof: boolean): string {
  return decoder.decode(decodeBase64(data), { stream: !eof });
}

export async function readFileForClientDownload(
  path: string,
  rpc: GatewayRpc,
  onProgress: (percent: number) => void = () => {},
  chunkSize = DOWNLOAD_CHUNK_BYTES,
): Promise<Blob> {
  const stat = await rpc<{ size: number; dir: boolean }>("fs:stat", { path });
  if (stat.dir) throw new Error("文件夹不能下载");
  if (stat.size > MAX_CLIENT_DOWNLOAD_BYTES) throw new Error("文件超过 256M，请通过终端传输");

  const chunks: ArrayBuffer[] = [];
  let offset = 0;
  do {
    const result = await rpc<FsReadResult>("fs:read", { path, offset, length: chunkSize }, 60_000);
    const bytes = decodeBase64(result.data);
    if (bytes.byteLength !== result.bytes) throw new Error("文件分块长度不一致，请重试");
    chunks.push(bytes.slice().buffer as ArrayBuffer);
    const nextOffset = result.offset + result.bytes;
    if (!result.eof && nextOffset <= offset) throw new Error("文件下载未取得进展，请重试");
    offset = nextOffset;
    onProgress(stat.size === 0 ? 100 : Math.min(100, Math.round((offset / stat.size) * 100)));
    if (result.eof) break;
  } while (offset < stat.size);

  return new Blob(chunks, { type: "application/octet-stream" });
}

export function isHtmlPreviewPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return HTML_EXTS.has(ext);
}

export function isMarkdownPreviewPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MARKDOWN_EXTS.has(ext);
}

export function isBrowserPreviewPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return BROWSER_PREVIEW_EXTS.has(ext);
}

function kindOf(path: string): Kind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (TEXT_EXTS.has(ext) || !path.includes(".")) return "text";
  if (IMG_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (PDF_EXTS.has(ext)) return "pdf";
  return "hex"; // still viewable as a dump
}

interface Props {
  path: string | null;
  gateway: FileWorkspaceGateway;
  onClose: () => void;
}

export default function FilePreview({ path, gateway, onClose }: Props) {
  const rpc = gateway.request;
  const [textChunks, setTextChunks] = useState<string[]>([]);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [hexDump, setHexDump] = useState<string>("");
  const [meta, setMeta] = useState<{ size: number; mtime: number } | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>("initial-loading");
  const [showInitialLoading, setShowInitialLoading] = useState(false);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [downloadDone, setDownloadDone] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareProgress, setShareProgress] = useState<number | null>(null);
  const [shareDone, setShareDone] = useState(false);
  const [eof, setEof] = useState(true);
  const [patch, setPatch] = useState<string | null>(null);
  const [diffStatus, setDiffStatus] = useState<TextInspectionResult["diffStatus"]>("unavailable");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [view, setView] = useState<"diff" | "file">("file");
  const [previewMode, setPreviewMode] = useState(false);
  const [editable, setEditable] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const editingRef = useRef(false);
  const generationRef = useRef(0);
  const chunkInFlightRef = useRef(false);
  const decoderRef = useRef(new TextDecoder("utf-8", { fatal: false }));
  const mediaTicketRef = useRef<string | null>(null);
  const activeMediaUrlRef = useRef<string | null>(null);
  const previewModeRef = useRef(false);

  const kind = path ? kindOf(path) : "unsupported";
  const isHtml = path ? isHtmlPreviewPath(path) : false;
  const isMarkdown = path ? isMarkdownPreviewPath(path) : false;
  const isRenderedDocument = isHtml || isMarkdown;
  const hasBrowserPreview = path ? isBrowserPreviewPath(path) : false;
  const text = useMemo(() => textChunks.join(""), [textChunks]);

  const revokeMediaTicket = useCallback(() => {
    const ticketId = mediaTicketRef.current;
    mediaTicketRef.current = null;
    if (ticketId) void rpc("fs:preview-close", { ticketId }).catch(() => {});
  }, [rpc]);

  const loadChunk = useCallback(
    async (target: string, fromStart = false, generation = generationRef.current) => {
      if (chunkInFlightRef.current) return;
      chunkInFlightRef.current = true;
      if (fromStart) setPhase("initial-loading");
      else setPhase("loading-more");
      setLoadMoreError(null);
      try {
        const offset = fromStart ? 0 : offsetRef.current;
        const res = await rpc<FsReadResult>("fs:read", {
          path: target,
          offset,
          length: 256 * 1024,
        });
        if (generation !== generationRef.current) return;
        const nextOffset = res.offset + res.bytes;
        if (!res.eof && nextOffset <= offset) throw new Error("文件加载未取得进展，请重试");
        if (fromStart) decoderRef.current = new TextDecoder("utf-8", { fatal: false });
        const chunk = decodeTextChunk(decoderRef.current, res.data, res.eof);
        offsetRef.current = nextOffset;
        setEof(res.eof);
        setLoadedBytes(nextOffset);
        setTextChunks((current) => (fromStart ? [chunk] : [...current, chunk]));
        setMeta((current) => ({ size: res.size, mtime: current?.mtime ?? 0 }));
        setErr(null);
        setPhase("ready");
      } catch (e: any) {
        if (generation !== generationRef.current) return;
        const message = e.message ?? String(e);
        if (fromStart) {
          setErr(message);
          setPhase("error");
        } else {
          setLoadMoreError(message);
          setPhase("ready");
        }
      } finally {
        if (generation === generationRef.current) chunkInFlightRef.current = false;
      }
    },
    [rpc],
  );

  const loadTextStatus = useCallback(async (target: string, generation: number) => {
    try {
      const result = await rpc<TextStatusResult>("fs:inspect-text-status", { path: target });
      if (generation !== generationRef.current) return;
      setMeta({ size: result.size, mtime: result.mtime });
      setDiffStatus(result.diffStatus);
      setEditable(!result.tooLarge);
      setExternalChange(false);
      setSaveError(null);
    } catch {}
  }, [rpc]);

  const loadMedia = useCallback(
    async (target: string, generation = generationRef.current) => {
      revokeMediaTicket();
      setPhase("initial-loading");
      setErr(null);
      try {
        const res = await rpc<MediaPreviewResult>("fs:preview-open", { path: target });
        if (generation !== generationRef.current) {
          void rpc("fs:preview-close", { ticketId: res.ticketId }).catch(() => {});
          return;
        }
        mediaTicketRef.current = res.ticketId;
        activeMediaUrlRef.current = res.url;
        setMediaUrl(res.url);
        setMeta({ size: res.size, mtime: res.mtime });
      } catch (e: any) {
        if (generation !== generationRef.current) return;
        setErr(e.message ?? String(e));
        setPhase("error");
      }
    },
    [revokeMediaTicket, rpc],
  );

  const loadHex = useCallback(async (target: string, generation = generationRef.current) => {
    setPhase("initial-loading");
    setErr(null);
    try {
      const result = await rpc<FsReadResult>("fs:read", { path: target, offset: 0, length: HEX_BYTES });
      if (generation !== generationRef.current) return;
      renderHex(result.data);
      setLoadedBytes(result.bytes);
      setMeta((current) => ({ size: result.size, mtime: current?.mtime ?? 0 }));
      setPhase("ready");
    } catch (error: any) {
      if (generation !== generationRef.current) return;
      setErr(error.message ?? String(error));
      setPhase("error");
    }
  }, [rpc]);

  function renderHex(b64: string) {
    const bin = atob(b64);
    const lines: string[] = [];
    for (let i = 0; i + 16 <= bin.length || i === 0; i += 16) {
      const slice = bin.slice(i, i + 16);
      const hex = [...slice].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
      const ascii = [...slice].map((c) => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127 ? c : ".")).join("");
      lines.push(`${i.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
      if (i + 16 > bin.length) break;
    }
    setHexDump(lines.join("\n"));
  }

  const startPreview = useCallback((target: string, targetKind: Kind) => {
    const generation = ++generationRef.current;
    const browserTarget = isBrowserPreviewPath(target);
    chunkInFlightRef.current = false;
    revokeMediaTicket();
    activeMediaUrlRef.current = null;
    setTextChunks([]); setMediaUrl(null); setHexDump(""); setMeta(null); setErr(null); setLoadMoreError(null); setLoadedBytes(0); setDownloadError(null); setDownloadProgress(null); setDownloadDone(false); setShareError(null); setShareProgress(null); setShareDone(false); setEof(true); setPatch(null); setDiffStatus("unavailable"); setDiffLoading(false); setDiffError(null); setView("file"); setEditable(false); setEditLoading(false); setEditing(false); setDraft(""); setSaveError(null); setExternalChange(false); setPhase("initial-loading");
    editingRef.current = false;
    offsetRef.current = 0;
    decoderRef.current = new TextDecoder("utf-8", { fatal: false });
    void rpc("fs:watch", { path: parentOf(target) }).catch(() => {});
    if (targetKind === "text") {
      void loadTextStatus(target, generation);
      void loadChunk(target, true, generation);
      if (browserTarget && previewModeRef.current) void loadMedia(target, generation);
    } else if (targetKind === "image" || targetKind === "video" || targetKind === "audio" || targetKind === "pdf") {
      void loadMedia(target, generation);
    } else if (targetKind === "hex") {
      void rpc<{ size: number; mtime: number }>("fs:stat", { path: target }).then((result) => {
        if (generation === generationRef.current) setMeta(result);
      }).catch(() => {});
      void loadHex(target, generation);
    }
  }, [loadChunk, loadHex, loadMedia, loadTextStatus, revokeMediaTicket, rpc]);

  useEffect(() => {
    if (!path) return;
    previewModeRef.current = false;
    setPreviewMode(false);
    startPreview(path, kind);
    return () => {
      generationRef.current++;
      chunkInFlightRef.current = false;
      revokeMediaTicket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // live refresh while previewing
  useEffect(() => {
    let refreshTimer: number | null = null;
    const handler = (e: Event) => {
      const changed = (e as CustomEvent).detail as string;
      if (!changed || changed !== path) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (kind === "text" && editingRef.current) {
          setExternalChange(true);
        } else if (path) startPreview(path, kind);
      }, 350);
    };
    window.addEventListener("file-changed", handler);
    return () => {
      window.removeEventListener("file-changed", handler);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [path, kind, startPreview]);

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    if (phase !== "initial-loading") {
      setShowInitialLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowInitialLoading(true), 120);
    return () => window.clearTimeout(timer);
  }, [path, phase]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const root = bodyRef.current;
    if (!sentinel || !root || !path || kind !== "text" || eof || editing || view !== "file" || phase !== "ready" || loadMoreError) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadChunk(path);
    }, { root, rootMargin: "0px 0px 360px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [editing, eof, kind, loadChunk, loadMoreError, path, phase, view]);

  const downloadBlob = useCallback((blob: Blob, target: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName(target);
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, []);

  const downloadToClient = useCallback(async () => {
    if (!path || downloadProgress !== null || shareProgress !== null) return;
    const target = path;
    setDownloadError(null);
    setShareError(null);
    setDownloadDone(false);
    setDownloadProgress(0);
    try {
      const blob = await readFileForClientDownload(target, rpc, setDownloadProgress);
      downloadBlob(blob, target);
      setDownloadDone(true);
      window.setTimeout(() => setDownloadDone(false), 1_500);
    } catch (error: any) {
      setDownloadError(error?.message ?? String(error));
    } finally {
      setDownloadProgress(null);
    }
  }, [downloadBlob, downloadProgress, path, rpc, shareProgress]);

  const shareToDevice = useCallback(async () => {
    if (!path || shareProgress !== null || downloadProgress !== null) return;
    const target = path;
    setDownloadError(null);
    setShareError(null);
    setShareDone(false);
    const readiness = nativeFileShareReadiness(navigator, window.isSecureContext);
    if (readiness === "insecure-context") {
      setShareError("当前页面是 HTTP，手机 Chrome 仅允许 HTTPS 页面分享文件，请改用 HTTPS 地址后重试");
      return;
    }
    if (readiness === "unsupported-browser") {
      setShareError("当前浏览器不支持分享文件，请使用最新版手机 Chrome 或系统浏览器");
      return;
    }
    setShareProgress(0);
    try {
      const blob = await readFileForClientDownload(target, rpc, setShareProgress);
      const file = new File([blob], fileName(target), {
        type: mimeTypeForPath(target),
        lastModified: meta?.mtime ?? Date.now(),
      });
      const outcome = await shareFileWithNativePicker(file, navigator);
      if (outcome === "unsupported") {
        setShareError("当前浏览器不支持分享此文件类型，请使用下载按钮");
      } else if (outcome === "shared") {
        setShareDone(true);
        window.setTimeout(() => setShareDone(false), 1_500);
      }
    } catch (error: any) {
      setShareError(error?.message ?? String(error));
    } finally {
      setShareProgress(null);
    }
  }, [downloadProgress, meta?.mtime, path, rpc, shareProgress]);

  const inspectFullText = useCallback(async (target: string, generation: number) => {
    const result = await rpc<TextInspectionResult>("fs:inspect-text", { path: target }, 60_000);
    if (generation !== generationRef.current) return null;
    setMeta({ size: result.size, mtime: result.mtime });
    setDiffStatus(result.diffStatus);
    setPatch(result.patch);
    setEditable(!result.tooLarge && result.validUtf8);
    return result;
  }, [rpc]);

  const beginEditing = useCallback(async () => {
    if (!path || editLoading) return;
    const generation = generationRef.current;
    setEditLoading(true);
    setSaveError(null);
    try {
      const result = await inspectFullText(path, generation);
      if (!result) return;
      if (result.tooLarge || result.data === null) throw new Error("文件超过 8M，无法在线编辑");
      if (!result.validUtf8) throw new Error("此文件不是有效的 UTF-8 文本，无法在线编辑");
      const fullText = new TextDecoder("utf-8", { fatal: false }).decode(decodeBase64(result.data));
      setTextChunks([fullText]);
      setLoadedBytes(result.size);
      offsetRef.current = result.size;
      setEof(true);
      setDraft(fullText);
      setExternalChange(false);
      editingRef.current = true;
      setEditing(true);
    } catch (error: any) {
      if (generation === generationRef.current) setSaveError(error.message ?? String(error));
    } finally {
      if (generation === generationRef.current) setEditLoading(false);
    }
  }, [editLoading, inspectFullText, path]);

  const selectDiffView = useCallback(async () => {
    if (!path || diffLoading) return;
    setView("diff");
    if (patch !== null) return;
    const generation = generationRef.current;
    setDiffLoading(true);
    setDiffError(null);
    try {
      await inspectFullText(path, generation);
    } catch (error: any) {
      if (generation === generationRef.current) setDiffError(error.message ?? String(error));
    } finally {
      if (generation === generationRef.current) setDiffLoading(false);
    }
  }, [diffLoading, inspectFullText, patch, path]);

  const togglePreviewMode = useCallback(() => {
    if (!path) return;
    const next = !previewMode;
    previewModeRef.current = next;
    setPreviewMode(next);
    if (next && !mediaUrl) void loadMedia(path, generationRef.current);
  }, [loadMedia, mediaUrl, path, previewMode]);

  const markMediaReady = useCallback((expectedUrl: string) => {
    if (activeMediaUrlRef.current !== expectedUrl) return;
    setErr(null);
    setPhase("ready");
  }, []);

  const markMediaFailed = useCallback((expectedUrl: string) => {
    if (activeMediaUrlRef.current !== expectedUrl) return;
    setErr("文件预览加载失败，请重试");
    setPhase("error");
  }, []);

  const retryPreview = useCallback(() => {
    if (path) startPreview(path, kind);
  }, [kind, path, startPreview]);

  const cancelEditing = useCallback(() => {
    if (draft !== text && !window.confirm("放弃未保存的修改？")) return;
    editingRef.current = false;
    setEditing(false);
    setDraft("");
    setSaveError(null);
    setExternalChange(false);
  }, [draft, text]);

  const closePreview = useCallback(() => {
    if (editing && draft !== text && !window.confirm("放弃未保存的修改并关闭预览？")) return;
    generationRef.current++;
    revokeMediaTicket();
    onClose();
  }, [draft, editing, onClose, revokeMediaTicket, text]);

  const reloadExternalChange = useCallback(() => {
    if (!path) return;
    editingRef.current = false;
    setEditing(false);
    setDraft("");
    startPreview(path, "text");
  }, [path, startPreview]);

  const saveDraft = useCallback(async () => {
    if (!path || !meta || saving || draft === text) return;
    setSaving(true);
    setSaveError(null);
    try {
      await rpc("fs:write-text", {
        path,
        content: draft,
        expectedSize: meta.size,
        expectedMtime: meta.mtime,
      }, 60_000);
      editingRef.current = false;
      setEditing(false);
      setDraft("");
      startPreview(path, "text");
    } catch (error: any) {
      setSaveError(error?.message ?? String(error));
    } finally {
      setSaving(false);
    }
  }, [draft, meta, path, rpc, saving, startPreview, text]);

  const parsedDiff = useMemo(() => parseUnifiedDiff(patch ?? ""), [patch]);

  if (!path) return null;

  const tooBig = (meta?.size ?? 0) > MAX_TEXT;
  const hasDiff = !tooBig && (diffStatus === "changed" || diffStatus === "untracked");
  const canEdit = kind === "text" && editable && phase !== "initial-loading" && !editLoading && !err;

  return (
    <div style={{
      height: "100%",
      display: "flex",
      flexDirection: "column",
      background: "var(--ui-term-col-bg, #101014)",
      color: "var(--ui-text, #e8e8ee)",
      colorScheme: "var(--ui-color-scheme, dark)",
      accentColor: "var(--ui-tab-accent, #7aa2f7)",
    }}>
      {/* header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 12px",
        borderBottom: "1px solid var(--ui-tree-border, #222)",
        background: "var(--ui-tree-bg, #121218)",
        flexShrink: 0,
      }}>
        <span className="pv-name" style={{ minWidth: 0, flex: "1 1 auto", fontSize: 12.5, color: "var(--ui-text, #e8e8ee)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {fileName(path)}
        </span>
        {meta && (
          <span style={{ fontSize: 10.5, color: "var(--ui-history-meta, #666)", flexShrink: 0 }}>{fmtSize(meta.size)}</span>
        )}
        {editing ? (
          <>
            <button type="button" onClick={cancelEditing} disabled={saving} style={HEADER_BUTTON_STYLES} aria-label="取消编辑" title="取消编辑">
              <RotateCcw size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={saveDraft}
              disabled={saving || draft === text}
              style={{ ...HEADER_BUTTON_STYLES, color: "var(--ui-tab-accent, #7aa2f7)", opacity: saving || draft === text ? 0.55 : 1 }}
              aria-label={saving ? "正在保存" : "保存修改"}
              title={saving ? "正在保存" : "保存修改"}
            >
              {saving ? <LoaderCircle className="tree-spin" size={15} strokeWidth={1.8} aria-hidden="true" /> : <Save size={15} strokeWidth={1.8} aria-hidden="true" />}
            </button>
          </>
        ) : (
          <>
            {kind === "text" && (
              <button
                type="button"
                onClick={beginEditing}
                disabled={!canEdit}
                style={{ ...HEADER_BUTTON_STYLES, opacity: canEdit ? 1 : 0.45 }}
                aria-label="编辑文件"
                title={tooBig ? "文件超过 8M，无法在线编辑" : editable ? "编辑文件" : "此文件不可编辑"}
              >
                <Pencil size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={downloadToClient}
              disabled={downloadProgress !== null || shareProgress !== null}
              style={{ ...HEADER_BUTTON_STYLES, opacity: downloadProgress !== null || shareProgress !== null ? 0.72 : 1 }}
              aria-label={downloadProgress === null ? "下载到当前设备" : `正在下载 ${downloadProgress}%`}
              title={downloadProgress === null ? "下载到当前设备" : `正在下载 ${downloadProgress}%`}
            >
              {downloadProgress !== null ? (
                <LoaderCircle className="tree-spin" size={15} strokeWidth={1.8} aria-hidden="true" />
              ) : downloadDone ? (
                <Check size={15} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Download size={15} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={shareToDevice}
              disabled={shareProgress !== null || downloadProgress !== null}
              style={{ ...HEADER_BUTTON_STYLES, opacity: shareProgress !== null || downloadProgress !== null ? 0.72 : 1 }}
              aria-label="分享文件"
              title={shareProgress === null ? "分享文件" : `正在准备 ${shareProgress}%`}
            >
              {shareProgress !== null ? (
                <LoaderCircle className="tree-spin" size={15} strokeWidth={1.8} aria-hidden="true" />
              ) : shareDone ? (
                <Check size={15} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Share2 size={15} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            {hasBrowserPreview && (
              <button
                type="button"
                onClick={togglePreviewMode}
                aria-pressed={previewMode}
                style={{
                  ...HEADER_BUTTON_STYLES,
                  ...(previewMode
                    ? { color: "var(--ui-tab-accent, #7aa2f7)", borderColor: "var(--ui-tab-accent, #7aa2f7)" }
                    : {}),
                }}
                aria-label={previewMode ? "退出浏览器预览" : "浏览器预览"}
                title={previewMode
                  ? "退出浏览器预览"
                  : isHtml
                    ? "在浏览器中预览渲染效果"
                    : isMarkdown
                      ? "预览 Markdown 排版效果"
                      : "在浏览器中查看原始文件"}
              >
                <Eye size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </>
        )}
        <button type="button" onClick={closePreview} style={HEADER_BUTTON_STYLES} aria-label="关闭预览" title="关闭预览">
          <X size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {kind === "text" && hasDiff && !editing && !previewMode && (
        <div style={{ display: "flex", alignItems: "center", minHeight: 34, padding: "0 12px", borderBottom: "1px solid var(--ui-tree-border, #222)", background: "var(--ui-tree-bg, #121218)", flexShrink: 0 }}>
          <div role="tablist" aria-label="文件预览模式" style={{ display: "inline-flex", gap: 2, padding: 2, border: "1px solid var(--ui-panel-input-border, #333)", borderRadius: 6, background: "var(--ui-muted-surface, #1b1b22)" }}>
            <PreviewTab active={view === "diff"} onClick={selectDiffView}>变更</PreviewTab>
            <PreviewTab active={view === "file"} onClick={() => setView("file")}>文件</PreviewTab>
          </div>
          <span style={{ marginLeft: 9, display: "inline-flex", gap: 7, fontFamily: '"SF Mono", Menlo, Consolas, monospace', fontSize: 10.5 }}>
            {parsedDiff.added > 0 && <span style={{ color: "var(--ui-success, #059669)" }}>+{parsedDiff.added}</span>}
            {parsedDiff.removed > 0 && <span style={{ color: "var(--ui-error, #dc2626)" }}>-{parsedDiff.removed}</span>}
          </span>
        </div>
      )}

      {shareError && (
        <div role="alert" style={{ flexShrink: 0, padding: "8px 12px", borderBottom: "1px solid var(--ui-tree-border, #222)", background: "var(--ui-tree-bg, #121218)", color: "var(--ui-error, #f7768e)", fontSize: 12.5, lineHeight: 1.5 }}>
          分享失败：{shareError}
        </div>
      )}

      <div ref={bodyRef} className="pv-body" style={{ position: "relative", flex: 1, minHeight: 0, overflow: "auto", background: "var(--ui-term-col-bg, #101014)", WebkitOverflowScrolling: "touch" }}>
        {downloadError && <div style={{ padding: "10px 14px 0", color: "var(--ui-error, #f7768e)", fontSize: 12.5 }}>下载失败：{downloadError}</div>}
        {saveError && <div role="alert" style={{ padding: "10px 14px", color: "var(--ui-error, #f7768e)", fontSize: 12.5 }}>{saveError}</div>}
        {externalChange && editing && (
          <div role="alert" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--ui-tree-border, #222)", color: "var(--ui-error, #f7768e)", fontSize: 12 }}>
            <span style={{ flex: 1 }}>文件已在其他位置更新</span>
            <button type="button" onClick={reloadExternalChange} style={INLINE_ACTION_STYLES}>
              <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
              重新加载
            </button>
          </div>
        )}

        {mediaUrl && !err && kind === "image" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl} alt={path} onLoad={() => markMediaReady(mediaUrl)} onError={() => markMediaFailed(mediaUrl)} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block", margin: "0 auto" }} />
        )}
        {mediaUrl && !err && kind === "video" && (
          <video src={mediaUrl} controls autoPlay onLoadedMetadata={() => markMediaReady(mediaUrl)} onError={() => markMediaFailed(mediaUrl)} style={{ maxWidth: "100%", maxHeight: "100%", display: "block", margin: "0 auto" }} />
        )}
        {mediaUrl && !err && kind === "audio" && (
          <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
            <audio src={mediaUrl} controls autoPlay onLoadedMetadata={() => markMediaReady(mediaUrl)} onError={() => markMediaFailed(mediaUrl)} style={{ width: "min(420px, 88%)" }} />
          </div>
        )}
        {mediaUrl && !err && kind === "pdf" && (
          <iframe src={mediaUrl} title={path} onLoad={() => markMediaReady(mediaUrl)} onError={() => markMediaFailed(mediaUrl)} style={{ width: "100%", height: "100%", border: "none" }} />
        )}
        {mediaUrl && !err && kind === "text" && hasBrowserPreview && previewMode && !editing && (
          // Rendered documents carry the file name so relative assets resolve
          // through the ticket route. Other text opens the primary raw URL.
          <iframe
            src={isRenderedDocument ? `${mediaUrl}/${encodeURIComponent(fileName(path))}` : mediaUrl}
            sandbox={HTML_IFRAME_SANDBOX}
            title={path}
            onLoad={() => markMediaReady(mediaUrl)}
            onError={() => markMediaFailed(mediaUrl)}
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
          />
        )}

        {kind === "text" && editing && !err && (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={`编辑 ${fileName(path)}`}
            style={{ width: "100%", minHeight: "100%", boxSizing: "border-box", resize: "none", margin: 0, padding: "12px 14px calc(env(safe-area-inset-bottom) + 36px)", border: 0, outline: 0, background: "var(--ui-term-col-bg, #101014)", color: "var(--ui-history-item-text, var(--ui-text, #d6d6de))", fontFamily: '"SF Mono", Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.5, tabSize: 2 }}
          />
        )}

        {kind === "text" && !editing && !err && hasDiff && view === "diff" && (
          diffError
            ? <CenteredStatus label={diffError} actionLabel="重试" onAction={() => void selectDiffView()} tone="error" />
            : diffLoading
            ? <CenteredStatus label="正在加载变更" />
            : <DiffPreview rows={parsedDiff.rows} />
        )}

        {(kind === "hex" || (kind === "text" && !editing && !previewMode && (!hasDiff || view === "file"))) && !err && (
          <>
            <pre
              style={{
                margin: 0,
                padding: "11px 13px calc(env(safe-area-inset-bottom) + 36px)",
                fontFamily: '"SF Mono", Menlo, Consolas, monospace',
                fontSize: kind === "hex" ? 10.5 : 12,
                lineHeight: 1.45,
                color: kind === "hex"
                  ? "var(--ui-muted-text, #9aa)"
                  : "var(--ui-history-item-text, var(--ui-text, #d6d6de))",
                whiteSpace: kind === "hex" ? "pre" : "pre-wrap",
                wordBreak: kind === "hex" ? "normal" : "break-word",
              }}
            >
              {kind === "hex"
                ? hexDump
                : textChunks.map((chunk, index) => <span key={index}>{chunk}</span>)}
            </pre>
            {kind === "text" && !eof && (
              <div
                ref={loadMoreRef}
                role="status"
                aria-live="polite"
                style={{ minHeight: 44, padding: "0 14px calc(env(safe-area-inset-bottom) + 8px)", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, color: "var(--ui-history-meta, #666)", fontSize: 11.5 }}
              >
                {phase === "loading-more" && <LoaderCircle className="tree-spin" size={14} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--ui-tab-accent, #7aa2f7)" }} />}
                {loadMoreError ? (
                  <>
                    <span>加载失败</span>
                    <button type="button" onClick={() => loadChunk(path)} style={INLINE_ACTION_STYLES}>
                      <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
                      重试
                    </button>
                  </>
                ) : (
                  <span>{phase === "loading-more" ? "正在加载更多" : `${fmtSize(loadedBytes)} / ${fmtSize(meta?.size ?? loadedBytes)}`}</span>
                )}
              </div>
            )}
          </>
        )}

        {showInitialLoading && phase === "initial-loading" && <CenteredStatus label="正在加载文件" />}
        {err && phase === "error" && <CenteredStatus label={err} actionLabel="重试" onAction={retryPreview} tone="error" />}
      </div>
    </div>
  );
}

function fileName(p: string) {
  return p.slice(p.lastIndexOf("/") + 1) || p;
}
function parentOf(p: string) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

const HEADER_BUTTON_STYLES: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 7, border: "1px solid var(--ui-panel-input-border, #333)",
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  background: "var(--ui-muted-surface, #1b1b22)", color: "var(--ui-muted-text, #ccc)", flexShrink: 0, cursor: "pointer",
};

const INLINE_ACTION_STYLES: React.CSSProperties = {
  minHeight: 28, padding: "0 9px", borderRadius: 6, border: "1px solid var(--ui-panel-input-border, #333)",
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
  background: "var(--ui-muted-surface, #1b1b22)", color: "var(--ui-muted-text, #ccc)", cursor: "pointer",
  fontSize: 11,
};

function CenteredStatus({
  label,
  actionLabel,
  onAction,
  tone = "muted",
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: "muted" | "error";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{ position: "absolute", inset: 0, minHeight: 120, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: tone === "error" ? "var(--ui-error, #f7768e)" : "var(--ui-muted-text, #9aa)", fontSize: 12.5 }}
    >
      {tone !== "error" && <LoaderCircle className="tree-spin" size={18} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--ui-tab-accent, #7aa2f7)" }} />}
      <span>{label}</span>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} style={INLINE_ACTION_STYLES}>
          <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function PreviewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{ minWidth: 48, height: 24, padding: "0 9px", border: 0, borderRadius: 4, background: active ? "var(--ui-tab-accent, #7aa2f7)" : "transparent", color: active ? "var(--ui-tab-active-text, #fff)" : "var(--ui-muted-text, #9aa)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
    >
      {children}
    </button>
  );
}

function DiffPreview({ rows }: { rows: FileDiffRow[] }) {
  return (
    <div style={{ minWidth: "100%", width: "max-content", paddingBottom: "calc(env(safe-area-inset-bottom) + 36px)", fontFamily: '"SF Mono", Menlo, Consolas, monospace', fontSize: 11.5, lineHeight: 1.55 }}>
      {rows.map((row, index) => {
        const added = row.kind === "added";
        const removed = row.kind === "removed";
        const structural = row.kind === "hunk" || row.kind === "meta" || row.kind === "note";
        const background = added
          ? "color-mix(in srgb, var(--ui-success, #059669) 12%, transparent)"
          : removed
            ? "color-mix(in srgb, var(--ui-error, #dc2626) 11%, transparent)"
            : row.kind === "hunk"
              ? "color-mix(in srgb, var(--ui-tab-accent, #7aa2f7) 10%, transparent)"
              : "transparent";
        const color = added
          ? "var(--ui-success, #059669)"
          : removed
            ? "var(--ui-error, #dc2626)"
            : structural
              ? "var(--ui-muted-text, #9aa)"
              : "var(--ui-history-item-text, var(--ui-text, #d6d6de))";
        return (
          <div key={`${row.kind}-${index}`} style={{ display: "grid", gridTemplateColumns: "42px 42px 22px minmax(0, 1fr)", minHeight: 18, background, color }}>
            <span style={DIFF_LINE_NUMBER_STYLES}>{row.oldLine ?? ""}</span>
            <span style={DIFF_LINE_NUMBER_STYLES}>{row.newLine ?? ""}</span>
            <span style={{ textAlign: "center", userSelect: "none", color }}>{added ? "+" : removed ? "-" : " "}</span>
            <span style={{ padding: "0 12px 0 6px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

const DIFF_LINE_NUMBER_STYLES: React.CSSProperties = {
  padding: "0 6px",
  borderRight: "1px solid var(--ui-tree-border, #222)",
  color: "var(--ui-history-meta, #666)",
  textAlign: "right",
  userSelect: "none",
};
