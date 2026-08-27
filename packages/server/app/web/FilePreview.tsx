"use client";
// FilePreview — routes by file type:
//   text    → chunked UTF-8 read with 继续加载
//   image   → <img> from fs:dataurl
//   video   → <video controls>
//   audio   → <audio controls>
//   pdf     → <iframe>
//   other   → hex dump (first 4 KiB) — everything is viewable
// Auto-refreshes when the gateway reports the open file changed on disk.

import { useCallback, useEffect, useRef, useState } from "react";

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

type Kind = "text" | "image" | "video" | "audio" | "pdf" | "hex" | "unsupported";

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
  rpc: <T = any,>(type: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  onClose: () => void;
}

export default function FilePreview({ path, rpc, onClose }: Props) {
  const [text, setText] = useState("");
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [hexDump, setHexDump] = useState<string>("");
  const [meta, setMeta] = useState<{ size: number; mtime: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [eof, setEof] = useState(true);
  const offsetRef = useRef(0);

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
          const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
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
    setText(""); setMediaUrl(null); setHexDump(""); setMeta(null); setErr(null); setEof(true);
    offsetRef.current = 0;
    if (!path) return;
    if (kind === "text") {
      rpc("fs:watch", { path: parentOf(path) }).catch(() => {});
      loadChunk(path, true);
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
        if (kind === "text") loadChunk(path!, true);
        else if (kind === "hex") loadMedia(path!, "hex");
        else loadMedia(path!, kind);
      }, 350);
    };
    window.addEventListener("file-changed", handler);
    return () => window.removeEventListener("file-changed", handler);
  }, [path, kind, loadChunk, loadMedia]);

  if (!path) return null;

  const tooBig = (meta?.size ?? 0) > MAX_TEXT;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#101014" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: "1px solid #222", flexShrink: 0 }}>
        <span className="pv-name" style={{ fontSize: 12.5, color: "#e8e8ee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {fileName(path)}
        </span>
        {meta && (
          <span style={{ fontSize: 10.5, color: "#666", flexShrink: 0 }}>{fmtSize(meta.size)}</span>
        )}
        <button onClick={onClose} style={{ marginLeft: "auto", ...CLOSE_STYLES }} aria-label="close">
          ✕
        </button>
      </div>

      <div className="pv-body" style={{ flex: 1, minHeight: 0, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
        {err && <div style={{ padding: 14, color: "#f7768e", fontSize: 12.5 }}>{err}</div>}

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

        {(kind === "text" || kind === "hex") && !err && (
          <>
            <pre
              style={{
                margin: 0,
                padding: "11px 13px calc(env(safe-area-inset-bottom) + 36px)",
                fontFamily: '"SF Mono", Menlo, Consolas, monospace',
                fontSize: kind === "hex" ? 10.5 : 12,
                lineHeight: 1.45,
                color: kind === "hex" ? "#9aa" : "#d6d6de",
                whiteSpace: kind === "hex" ? "pre" : "pre-wrap",
                wordBreak: kind === "hex" ? "normal" : "break-word",
              }}
            >
              {kind === "hex" ? hexDump : text}
              {kind === "text" && !eof && <span style={{ color: "#555" }}> …</span>}
            </pre>
            {kind === "text" && !eof && !tooBig && (
              <button
                disabled={loading}
                onClick={() => loadChunk(path)}
                style={{
                  display: "block", margin: "0 auto 18px", padding: "7px 20px",
                  borderRadius: 99, border: "1px solid #333", background: "#1b1b22", color: "#9aa", fontSize: 12.5,
                }}
              >
                {loading ? "加载中…" : "继续加载"}
              </button>
            )}
          </>
        )}

        {!mediaUrl && kind !== "text" && kind !== "hex" && !err && loading && (
          <div style={{ padding: 14, color: "#667", fontSize: 12.5 }}>加载中…</div>
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

const CLOSE_STYLES: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 7, border: "1px solid #333",
  background: "#1b1b22", color: "#ccc", fontSize: 13, flexShrink: 0,
};
