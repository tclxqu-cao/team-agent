"use client";
// FilePreview — routes by file type:
//   text    → chunked UTF-8 read with 继续加载
//   image   → <img> from fs:dataurl
//   video   → <video controls>
//   audio   → <audio controls>
//   pdf     → <iframe>
//   other   → hex dump (first 4 KiB) — everything is viewable
// Auto-refreshes when the gateway reports the open file changed on disk.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, LoaderCircle, Pencil, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import { parseUnifiedDiff, type FileDiffRow } from "./fileDiff";

const TEXT_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "css", "scss",
  "html", "xml", "yml", "yaml", "toml", "sh", "zsh", "bash", "py", "rb", "go",
  "rs", "java", "kt", "c", "h", "cpp", "hpp", "sql", "env", "gitignore",
  "dockerfile", "txt", "log", "conf", "properties", "gradle", "lock", "csv",
  "vue", "svelte", "astro", "graphql", "prisma", "proto",
]);
const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"]);
const PDF_EXTS = new Set(["pdf"]);
const MAX_TEXT = 8 * 1024 * 1024;
const HEX_BYTES = 4096;
const DOWNLOAD_CHUNK_BYTES = 512 * 1024;
export const MAX_CLIENT_DOWNLOAD_BYTES = 256 * 1024 * 1024;

type Kind = "text" | "image" | "video" | "audio" | "pdf" | "hex" | "unsupported";
type GatewayRpc = <T = any,>(type: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

interface FsReadResult {
  data: string;
  bytes: number;
  offset: number;
  eof: boolean;
  size: number;
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

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
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
  rpc: GatewayRpc;
  onClose: () => void;
}

export default function FilePreview({ path, rpc, onClose }: Props) {
  const [text, setText] = useState("");
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [hexDump, setHexDump] = useState<string>("");
  const [meta, setMeta] = useState<{ size: number; mtime: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [downloadDone, setDownloadDone] = useState(false);
  const [eof, setEof] = useState(true);
  const [patch, setPatch] = useState<string | null>(null);
  const [view, setView] = useState<"diff" | "file">("file");
  const [editable, setEditable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const offsetRef = useRef(0);
  const editingRef = useRef(false);

  const kind = path ? kindOf(path) : "unsupported";

  // text: load one chunk (from start or continuing)
  const loadChunk = useCallback(
    async (target: string, fromStart = false) => {
      setLoading(true);
      setErr(null);
      try {
        const offset = fromStart ? 0 : offsetRef.current;
        const res = await rpc<{ data: string; bytes: number; offset: number; eof: boolean; size: number }>("fs:read", {
          path: target,
          offset,
          length: 256 * 1024,
        });
        let chunk = "";
        try {
          const bytes = decodeBase64(res.data);
          chunk = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        } catch {}
        offsetRef.current = res.offset + res.bytes;
        setEof(res.eof);
        setText((prev) => (fromStart ? chunk : prev + chunk));
        setMeta({ size: res.size, mtime: Date.now() });
      } catch (e: any) {
        setErr(e.message ?? String(e));
      } finally {
        setLoading(false);
      }
    },
    [rpc],
  );

  const loadTextPreview = useCallback(async (target: string) => {
    setLoading(true);
    setErr(null);
    try {
      const result = await rpc<TextInspectionResult>("fs:inspect-text", { path: target }, 60_000);
      setMeta({ size: result.size, mtime: result.mtime });
      setPatch(result.patch);
      setView(result.patch ? "diff" : "file");
      setEditable(!result.tooLarge && result.validUtf8);
      setExternalChange(false);
      setSaveError(null);
      offsetRef.current = 0;
      if (result.tooLarge || result.data === null) {
        await loadChunk(target, true);
        return;
      }
      setText(new TextDecoder("utf-8", { fatal: false }).decode(decodeBase64(result.data)));
      setEof(true);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [loadChunk, rpc]);

  // binary/media: fetch whole file as data URL (+ hex fallback bytes)
  const loadMedia = useCallback(
    async (target: string, k: Kind) => {
      setLoading(true);
      setErr(null);
      try {
        const res = await rpc<{ mime: string; data: string; size: number; mtime: number }>(
          "fs:dataurl",
          { path: target },
          60000,
        );
        setMediaUrl(`data:${res.mime};base64,${res.data}`);
        setMeta({ size: res.size, mtime: res.mtime });
        if (k === "hex") renderHex(res.data.slice(0, Math.ceil((HEX_BYTES * 4) / 3)));
      } catch (e: any) {
        // file too big for inline — fall back to hex head via chunked read
        if (e?.message?.includes("too large")) {
          try {
            const head = await rpc<{ data: string }>("fs:read", { path: target, offset: 0, length: HEX_BYTES });
            renderHex(head.data);
            setErr(`文件过大（>${16}MiB），仅显示前 ${HEX_BYTES / 1024}K 的十六进制`);
          } catch (e2: any) {
            setErr(e2.message ?? String(e2));
          }
        } else {
          setErr(e.message ?? String(e));
        }
      } finally {
        setLoading(false);
      }
    },
    [rpc],
  );

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

  // full reload on file switch
  useEffect(() => {
    setText(""); setMediaUrl(null); setHexDump(""); setMeta(null); setErr(null); setDownloadError(null); setDownloadProgress(null); setDownloadDone(false); setEof(true); setPatch(null); setView("file"); setEditable(false); setEditing(false); setDraft(""); setSaveError(null); setExternalChange(false);
    editingRef.current = false;
    offsetRef.current = 0;
    if (!path) return;
    if (kind === "text") {
      rpc("fs:watch", { path: parentOf(path) }).catch(() => {});
      loadTextPreview(path);
    } else if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
      rpc("fs:watch", { path: parentOf(path) }).catch(() => {});
      loadMedia(path, kind);
    } else if (kind === "hex") {
      rpc("fs:watch", { path: parentOf(path) }).catch(() => {});
      loadMedia(path, "hex");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // live refresh while previewing
  useEffect(() => {
    const handler = (e: Event) => {
      const changed = (e as CustomEvent).detail as string;
      if (!changed || changed !== path) return;
      setTimeout(() => {
        if (kind === "text" && editingRef.current) {
          setExternalChange(true);
        } else if (kind === "text") loadTextPreview(path!);
        else if (kind === "hex") loadMedia(path!, "hex");
        else loadMedia(path!, kind);
      }, 350);
    };
    window.addEventListener("file-changed", handler);
    return () => window.removeEventListener("file-changed", handler);
  }, [path, kind, loadMedia, loadTextPreview]);

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  const downloadToClient = useCallback(async () => {
    if (!path || downloadProgress !== null) return;
    const target = path;
    setDownloadError(null);
    setDownloadDone(false);
    setDownloadProgress(0);
    try {
      const blob = await readFileForClientDownload(target, rpc, setDownloadProgress);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName(target);
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setDownloadDone(true);
      window.setTimeout(() => setDownloadDone(false), 1_500);
    } catch (error: any) {
      setDownloadError(error?.message ?? String(error));
    } finally {
      setDownloadProgress(null);
    }
  }, [downloadProgress, path, rpc]);

  const beginEditing = useCallback(() => {
    setDraft(text);
    setSaveError(null);
    setExternalChange(false);
    editingRef.current = true;
    setEditing(true);
  }, [text]);

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
    onClose();
  }, [draft, editing, onClose, text]);

  const reloadExternalChange = useCallback(() => {
    if (!path) return;
    editingRef.current = false;
    setEditing(false);
    setDraft("");
    void loadTextPreview(path);
  }, [loadTextPreview, path]);

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
      await loadTextPreview(path);
    } catch (error: any) {
      setSaveError(error?.message ?? String(error));
    } finally {
      setSaving(false);
    }
  }, [draft, loadTextPreview, meta, path, rpc, saving, text]);

  const parsedDiff = useMemo(() => parseUnifiedDiff(patch ?? ""), [patch]);

  if (!path) return null;

  const tooBig = (meta?.size ?? 0) > MAX_TEXT;
  const hasDiff = Boolean(patch);
  const canEdit = kind === "text" && editable && !loading && !err;

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
              disabled={downloadProgress !== null}
              style={{ ...HEADER_BUTTON_STYLES, opacity: downloadProgress !== null ? 0.72 : 1 }}
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
          </>
        )}
        <button type="button" onClick={closePreview} style={HEADER_BUTTON_STYLES} aria-label="关闭预览" title="关闭预览">
          <X size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {kind === "text" && hasDiff && !editing && (
        <div style={{ display: "flex", alignItems: "center", minHeight: 34, padding: "0 12px", borderBottom: "1px solid var(--ui-tree-border, #222)", background: "var(--ui-tree-bg, #121218)", flexShrink: 0 }}>
          <div role="tablist" aria-label="文件预览模式" style={{ display: "inline-flex", gap: 2, padding: 2, border: "1px solid var(--ui-panel-input-border, #333)", borderRadius: 6, background: "var(--ui-muted-surface, #1b1b22)" }}>
            <PreviewTab active={view === "diff"} onClick={() => setView("diff")}>变更</PreviewTab>
            <PreviewTab active={view === "file"} onClick={() => setView("file")}>文件</PreviewTab>
          </div>
          <span style={{ marginLeft: 9, display: "inline-flex", gap: 7, fontFamily: '"SF Mono", Menlo, Consolas, monospace', fontSize: 10.5 }}>
            {parsedDiff.added > 0 && <span style={{ color: "var(--ui-success, #059669)" }}>+{parsedDiff.added}</span>}
            {parsedDiff.removed > 0 && <span style={{ color: "var(--ui-error, #dc2626)" }}>-{parsedDiff.removed}</span>}
          </span>
        </div>
      )}

      <div className="pv-body" style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--ui-term-col-bg, #101014)", WebkitOverflowScrolling: "touch" }}>
        {downloadError && <div style={{ padding: "10px 14px 0", color: "var(--ui-error, #f7768e)", fontSize: 12.5 }}>下载失败：{downloadError}</div>}
        {err && <div style={{ padding: 14, color: "var(--ui-error, #f7768e)", fontSize: 12.5 }}>{err}</div>}
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

        {mediaUrl && kind === "image" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl} alt={path} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block", margin: "0 auto" }} />
        )}
        {mediaUrl && kind === "video" && (
          <video src={mediaUrl} controls autoPlay style={{ maxWidth: "100%", maxHeight: "100%", display: "block", margin: "0 auto" }} />
        )}
        {mediaUrl && kind === "audio" && (
          <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
            <audio src={mediaUrl} controls autoPlay style={{ width: "min(420px, 88%)" }} />
          </div>
        )}
        {mediaUrl && kind === "pdf" && (
          <iframe src={mediaUrl} title={path} style={{ width: "100%", height: "100%", border: "none" }} />
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
          <DiffPreview rows={parsedDiff.rows} />
        )}

        {(kind === "hex" || (kind === "text" && !editing && (!hasDiff || view === "file"))) && !err && (
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
              {kind === "hex" ? hexDump : text}
              {kind === "text" && !eof && <span style={{ color: "var(--ui-history-meta, #666)" }}> …</span>}
            </pre>
            {kind === "text" && !eof && !tooBig && (
              <button
                disabled={loading}
                onClick={() => loadChunk(path)}
                style={{
                  display: "block", margin: "0 auto 18px", padding: "7px 20px",
                  borderRadius: 99,
                  border: "1px solid var(--ui-panel-input-border, #333)",
                  background: "var(--ui-muted-surface, #1b1b22)",
                  color: "var(--ui-muted-text, #9aa)",
                  fontSize: 12.5,
                }}
              >
                {loading ? "加载中…" : "继续加载"}
              </button>
            )}
          </>
        )}

        {!mediaUrl && kind !== "text" && kind !== "hex" && !err && loading && (
          <div style={{ padding: 14, color: "var(--ui-muted-text, #667)", fontSize: 12.5 }}>加载中…</div>
        )}
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
