"use client";
// FileTree — pure lazy-loading tree. NOTHING is listed until the user taps to
// expand (each tap = one fs:list for that directory only). Optionally follows
// the terminal's cwd: when the shell changes directory, the tree re-roots.

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyFileContent, type FileContentKind } from "../../../core/src/domain/file/file-types";
import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileText,
  FileVideo2,
  Folder,
  FolderOpen,
  LoaderCircle,
  LocateFixed,
  NotebookText,
  Palette,
  Presentation,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import type { FsEntry, FsEvent } from "./useGateway";
import {
  ancestorDirectories,
  isPathInsideRoot,
  parentDirectory,
  type FileTreeRevealRequest,
} from "./fileTreeReveal";

interface Props {
  rpc: <T = any,>(type: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  onEvent: (type: string, fn: (msg: any) => void) => () => void;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
  ready: boolean;
  /** terminal cwd; tree roots here and re-roots when it changes */
  cwd?: string | null;
  followCwd?: boolean;
  initialRoot?: string | null;
  initialFollow?: boolean;
  onTreeStateChange?: (root: string, following: boolean) => void;
  revealRequest?: FileTreeRevealRequest | null;
}

const fileIconDetails: Record<FileContentKind, { icon: LucideIcon; color: string; label: string }> = {
  code: { icon: FileCode2, color: "#7aa2f7", label: "代码文件" },
  style: { icon: Palette, color: "#bb9af7", label: "样式文件" },
  image: { icon: FileImage, color: "#9ece6a", label: "图片文件" },
  video: { icon: FileVideo2, color: "#f7768e", label: "视频文件" },
  audio: { icon: FileAudio, color: "#c099ff", label: "音频文件" },
  markdown: { icon: NotebookText, color: "#73daca", label: "Markdown 文件" },
  text: { icon: FileText, color: "#a9b1d6", label: "文本文件" },
  json: { icon: FileJson2, color: "#e0af68", label: "JSON 文件" },
  archive: { icon: FileArchive, color: "#ff9e64", label: "压缩文件" },
  spreadsheet: { icon: FileSpreadsheet, color: "#9ece6a", label: "表格文件" },
  presentation: { icon: Presentation, color: "#f7768e", label: "演示文件" },
  database: { icon: Database, color: "#2ac3de", label: "数据库文件" },
  file: { icon: File, color: "#c8c8d0", label: "文件" },
};

function fileIcon(name: string) {
  return fileIconDetails[classifyFileContent(name)];
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

interface DirState {
  path: string;
  depth: number;
  expanded: boolean;
  children: FsEntry[] | null; // null = not yet fetched
  loading: boolean;
  error?: string;
}

export default function FileTree({ rpc, onEvent, onOpenFile, selectedPath, ready, cwd, followCwd, initialRoot, initialFollow = true, onTreeStateChange, revealRequest }: Props) {
  const [root, setRoot] = useState<DirState | null>(null);
  const [filter, setFilter] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [manualRoot, setManualRoot] = useState(!initialFollow);
  const [home, setHome] = useState("");
  /** dirPath → children state map for all EXPANDED dirs */
  const dirsRef = useRef<Map<string, DirState>>(new Map());
  const lastRootRef = useRef<string | null>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const latestRevealRequestRef = useRef(0);
  const startedRevealRequestRef = useRef(0);
  const [, bump] = useState(0);
  const rerender = () => bump((x) => x + 1);

  const fetchDir = useCallback(
    async (dirPath: string, depth: number): Promise<DirState> => {
      const st: DirState = { path: dirPath, depth, expanded: true, children: null, loading: true };
      dirsRef.current.set(dirPath, st);
      rerender();
      try {
        const res = await rpc<{ entries: FsEntry[] }>("fs:list", { path: dirPath });
        st.children = res.entries;
        // Watch exactly this loaded level. Claude/Codex/TUI edits then push an
        // fs:event and refresh the visible listing without recursive prefetch.
        rpc("fs:watch", { path: dirPath }).catch(() => {});
      } catch (err: any) {
        st.children = [];
        st.error = err?.message ?? "read failed";
      }
      st.loading = false;
      rerender();
      return st;
    },
    [rpc],
  );

  const followingTerminal = Boolean(followCwd) && !manualRoot;

  const applyRoot = useCallback((nextPath: string) => {
    const normalized = nextPath.length > 1 ? nextPath.replace(/\/+$/, "") : nextPath;
    lastRootRef.current = normalized;
    dirsRef.current.clear();
    setRoot({ path: normalized, depth: 0, expanded: false, children: null, loading: false });
    setPathInput(normalized);
  }, []);

  // (re-)root the tree when cwd becomes known or changes
  useEffect(() => {
    if (!ready || !cwd || !followingTerminal) return;
    if (lastRootRef.current === cwd) return;
    applyRoot(cwd);
    onTreeStateChange?.(cwd, true);
  }, [ready, cwd, followingTerminal, applyRoot]);

  useEffect(() => {
    if (!ready || !initialRoot || initialFollow || lastRootRef.current) return;
    setManualRoot(true);
    applyRoot(initialRoot);
  }, [ready, initialRoot, initialFollow, applyRoot]);

  // fallback root: home (~) — sent by hello()
  useEffect(() => {
    if (!ready) return;
    rpc<{ home: string }>("hello").then((res) => {
      setHome(res.home);
      if (followingTerminal && !cwd && !lastRootRef.current) applyRoot(res.home);
    }).catch(() => {});
  }, [ready, cwd, followingTerminal, rpc, applyRoot]);

  const locatePath = () => {
    let target = pathInput.trim();
    if (!target) return;
    if (target === "~") target = home || cwd || "/";
    else if (target.startsWith("~/")) target = `${home || cwd || ""}${target.slice(1)}`;
    else if (!target.startsWith("/")) target = `${cwd || root?.path || home || "/"}/${target}`;
    target = target.replace(/\/+/g, "/");
    setManualRoot(true);
    applyRoot(target);
    onTreeStateChange?.(target, false);
  };

  const resumeFollowing = () => {
    setManualRoot(false);
    if (cwd) { applyRoot(cwd); onTreeStateChange?.(cwd, true); }
  };

  const toggleDir = useCallback(
    async (p: string) => {
      let st = dirsRef.current.get(p);
      if (!st) {
        // root (or never-visited dir): register it first
        st = { path: p, depth: 0, expanded: false, children: null, loading: false };
        dirsRef.current.set(p, st);
      }
      if (st.expanded) {
        st.expanded = false;
      } else {
        st.expanded = true;
        if (!st.children && !st.loading) await fetchDir(p, st.depth);
      }
      rerender();
    },
    [fetchDir],
  );

  const openDirAtDepth = useCallback(
    async (p: string, depth: number) => {
      let st = dirsRef.current.get(p);
      if (!st) {
        st = await fetchDir(p, depth);
      } else if (!st.children && !st.loading) {
        await fetchDir(p, depth);
      }
      st.expanded = true;
      rerender();
    },
    [fetchDir],
  );

  const revealFile = useCallback(async (targetPath: string, requestId: number) => {
    const targetParent = parentDirectory(targetPath);
    let revealRoot = root?.path ?? targetParent;
    if (!isPathInsideRoot(targetPath, revealRoot)) {
      revealRoot = targetParent;
      setManualRoot(true);
      applyRoot(revealRoot);
      onTreeStateChange?.(revealRoot, false);
    }

    const ancestors = ancestorDirectories(revealRoot, targetPath);
    for (let depth = 0; depth < ancestors.length; depth += 1) {
      if (latestRevealRequestRef.current !== requestId) return;
      await openDirAtDepth(ancestors[depth], depth);
    }

    const scrollToTarget = () => {
      if (latestRevealRequestRef.current !== requestId) return;
      const row = Array.from(treeScrollRef.current?.querySelectorAll<HTMLElement>("[data-tree-path]") ?? [])
        .find((element) => element.dataset.treePath === targetPath);
      row?.scrollIntoView({ block: "center", inline: "nearest" });
    };
    requestAnimationFrame(() => requestAnimationFrame(scrollToTarget));
  }, [applyRoot, onTreeStateChange, openDirAtDepth, root?.path]);

  useEffect(() => {
    if (!ready || !revealRequest) return;
    if (startedRevealRequestRef.current === revealRequest.requestId) return;
    startedRevealRequestRef.current = revealRequest.requestId;
    latestRevealRequestRef.current = revealRequest.requestId;
    void revealFile(revealRequest.path, revealRequest.requestId);
  }, [ready, revealFile, revealRequest?.requestId]);

  // realtime refresh of loaded+expanded dirs when fs events arrive nearby
  useEffect(() => {
    return onEvent("fs:event", (msg: { events: FsEvent[] }) => {
      for (const ev of msg.events ?? []) {
        const changed = ev.path as string;
        if (changed === selectedPath) window.dispatchEvent(new CustomEvent("file-changed", { detail: changed }));
        const parent = changed.slice(0, changed.lastIndexOf("/")) || "/";
        const st = dirsRef.current.get(parent);
        if (st?.expanded && st.children && !st.loading) {
          fetchDir(parent, st.depth).catch(() => {});
        }
      }
    });
  }, [onEvent, selectedPath, fetchDir]);

  const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

  const normalizedFilter = filter.trim().toLowerCase();
  const matchesLoadedTree = (parentPath: string, entry: FsEntry): boolean => {
    if (!normalizedFilter || entry.name.toLowerCase().includes(normalizedFilter)) return true;
    if (!entry.dir) return false;
    const childPath = join(parentPath, entry.name);
    const loaded = dirsRef.current.get(childPath)?.children;
    return loaded?.some((child) => matchesLoadedTree(childPath, child)) ?? false;
  };

  const renderEntries = (parentPath: string, entries: FsEntry[], depth: number): React.ReactNode =>
    entries.filter((child) => matchesLoadedTree(parentPath, child)).map((child) => {
      const full = join(parentPath, child.name);
      if (child.dir) {
        const st = dirsRef.current.get(full);
        const expanded = st?.expanded ?? false;
        return (
          <div key={full}>
            <div className="tree-row" onClick={() => toggleDir(full)} style={{ paddingLeft: 6 + depth * 12 }}>
              <span className="tree-disclosure" aria-hidden="true">
                {st?.loading ? <LoaderCircle className="tree-spin" size={13} /> : expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
              <span className="tree-entry-icon tree-folder-icon" aria-hidden="true">
                {expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
              </span>
              <span className="tree-entry-name">{child.name}</span>
            </div>
            {expanded &&
              (st!.children ? (
                renderEntries(full, st!.children!, depth + 1)
              ) : (
                <div className="tree-row" style={{ paddingLeft: 22 + depth * 12, color: "#556" }}>
                  …
                </div>
              ))}
          </div>
        );
      }
      const details = fileIcon(child.name);
      const EntryIcon = details.icon;
      return (
        <div
          key={full}
          className="tree-row"
          data-tree-path={full}
          data-selected={full === selectedPath ? "1" : undefined}
          onClick={() => onOpenFile(full)}
          title={`${details.label} · ${full} · ${fmtSize(child.size)}`}
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <span className="tree-disclosure" aria-hidden="true" />
          <span className="tree-entry-icon" style={{ color: details.color }} aria-hidden="true">
            <EntryIcon size={16} strokeWidth={1.8} />
          </span>
          <span className="tree-entry-name">{child.name}</span>
          <span className="tree-size">{fmtSize(child.size)}</span>
        </div>
      );
    });

  if (!root) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: "#556" }}>
        {followingTerminal ? (ready ? "等待终端目录…" : "连接中…") : "…"}
      </div>
    );
  }

  const rootSt = dirsRef.current.get(root.path);
  return (
    <div className="tree-scroll" ref={treeScrollRef}>
      <div className="tree-location">
        <input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") locatePath();
          }}
          placeholder="输入目录路径"
          aria-label="文件树目录路径"
          spellCheck={false}
        />
        <button tabIndex={-1} onClick={locatePath} title="定位目录" aria-label="定位目录">
          <CornerDownLeft size={14} aria-hidden="true" />
        </button>
        <button
          tabIndex={-1}
          onClick={resumeFollowing}
          title="跟随终端目录"
          aria-label="跟随终端目录"
          data-active={followingTerminal ? "1" : undefined}
        >
          <LocateFixed size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="tree-filter">
        <Search size={14} aria-hidden="true" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选已加载文件"
          aria-label="筛选文件树"
        />
        {filter && (
          <button tabIndex={-1} onClick={() => setFilter("")} aria-label="清除筛选">
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {/* root row — one tap expands level 1 */}
      <div className="tree-row" onClick={() => toggleDir(root.path)}>
        <span className="tree-disclosure" aria-hidden="true">
          {rootSt?.loading ? <LoaderCircle className="tree-spin" size={13} /> : rootSt?.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className="tree-entry-icon tree-folder-icon" aria-hidden="true">
          {rootSt?.expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
        </span>
        <span className="tree-entry-name" style={{ direction: "rtl" as const, textAlign: "left" as const }}>
          {root.path}
        </span>
      </div>
      {rootSt?.expanded &&
        (rootSt.children ? (
          renderEntries(root.path, rootSt.children, 1)
        ) : (
          <div className="tree-row" style={{ paddingLeft: 24, color: "#556" }}>…</div>
        ))}
    </div>
  );
}
