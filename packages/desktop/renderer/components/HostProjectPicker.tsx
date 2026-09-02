import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { classifyFileContent, type FileContentKind } from "../../../core/src/domain/file/file-types";
import {
  ArrowLeft,
  ChevronRight,
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
  NotebookText,
  Palette,
  Presentation,
  RefreshCw,
  X,
  type LucideIcon,
} from "lucide-react";

interface HostDirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  hasChildren: boolean;
}

interface HostProjectPickerProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (path: string) => Promise<void> | void;
}

export interface ProjectBreadcrumb {
  label: string;
  path: string;
}

export type HostEntryIconKind = "folder" | FileContentKind;

const iconDetails: Record<HostEntryIconKind, { icon: LucideIcon; label: string }> = {
  folder: { icon: Folder, label: "文件夹" },
  code: { icon: FileCode2, label: "代码文件" },
  style: { icon: Palette, label: "样式文件" },
  image: { icon: FileImage, label: "图片文件" },
  video: { icon: FileVideo2, label: "视频文件" },
  audio: { icon: FileAudio, label: "音频文件" },
  markdown: { icon: NotebookText, label: "Markdown 文件" },
  text: { icon: FileText, label: "文本文件" },
  json: { icon: FileJson2, label: "JSON 文件" },
  archive: { icon: FileArchive, label: "压缩文件" },
  spreadsheet: { icon: FileSpreadsheet, label: "表格文件" },
  presentation: { icon: Presentation, label: "演示文件" },
  database: { icon: Database, label: "数据库文件" },
  file: { icon: File, label: "文件" },
};

export function getHostEntryIconKind(name: string, kind: HostDirectoryEntry["kind"]): HostEntryIconKind {
  return kind === "directory" ? "folder" : classifyFileContent(name);
}

const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";

export function buildProjectBreadcrumbs(rootPath: string, currentPath: string): ProjectBreadcrumb[] {
  const root = normalize(rootPath);
  const current = normalize(currentPath);
  const rootLabel = root === "/" ? "/" : root.split("/").filter(Boolean).pop() || root;
  const breadcrumbs: ProjectBreadcrumb[] = [{ label: rootLabel, path: root }];
  if (current === root) return breadcrumbs;
  const relative = current.slice(root === "/" ? 1 : root.length + 1);
  let cursor = root;
  for (const segment of relative.split("/").filter(Boolean)) {
    cursor = cursor === "/" ? `/${segment}` : `${cursor}/${segment}`;
    breadcrumbs.push({ label: segment, path: cursor });
  }
  return breadcrumbs;
}

export default function HostProjectPicker({ open, onCancel, onConfirm }: HostProjectPickerProps) {
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState("");
  const [current, setCurrent] = useState("");
  const [entries, setEntries] = useState<HostDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const breadcrumbs = useMemo(() => buildProjectBreadcrumbs(root || "/", current || root || "/"), [root, current]);

  const loadDirectory = async (path: string) => {
    if (!window.agentApi) return;
    setLoading(true);
    setError("");
    try {
      const list = await window.agentApi.listProjectDirectories(path);
      setEntries(list);
      setCurrent(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取目录");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !window.agentApi) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void window.agentApi.listProjectRoots().then(async (list) => {
      if (cancelled) return;
      setRoots(list);
      const initial = list[0] ?? "";
      setRoot(initial);
      if (initial) await loadDirectory(initial);
      else setError("未配置可用的宿主机目录");
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "无法读取宿主机目录");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const selectRoot = (nextRoot: string) => {
    setRoot(nextRoot);
    void loadDirectory(nextRoot);
  };
  const goBack = () => {
    if (breadcrumbs.length <= 1) return;
    void loadDirectory(breadcrumbs[breadcrumbs.length - 2].path);
  };
  const confirm = async () => {
    if (!current || confirming) return;
    setConfirming(true);
    setError("");
    try {
      await onConfirm(current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "项目导入失败");
    } finally {
      setConfirming(false);
    }
  };

  return createPortal(
    <div className="host-project-picker-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="host-project-picker" role="dialog" aria-modal="true" aria-labelledby="host-project-picker-title">
        <header className="host-project-picker-header">
          <div>
            <h2 id="host-project-picker-title">选择宿主机项目</h2>
            <p>文件将直接在运行 AgentRoam 的机器上读写</p>
          </div>
          <button type="button" className="ui-icon-button" onClick={onCancel} aria-label="关闭目录选择器" title="关闭">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {roots.length > 1 && (
          <label className="host-project-picker-root">
            <span>根目录</span>
            <select value={root} onChange={(event) => selectRoot(event.target.value)}>
              {roots.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        )}

        <nav className="host-project-picker-nav" aria-label="当前目录">
          <button type="button" className="ui-icon-button" onClick={goBack} disabled={breadcrumbs.length <= 1} aria-label="返回上级目录" title="返回上级目录">
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <div className="host-project-picker-breadcrumbs">
            {breadcrumbs.map((item, index) => (
              <span key={item.path}>
                {index > 0 && <i>/</i>}
                <button type="button" onClick={() => void loadDirectory(item.path)}>{item.label}</button>
              </span>
            ))}
          </div>
          <button type="button" className="ui-icon-button" onClick={() => current && void loadDirectory(current)} disabled={!current || loading} aria-label="刷新目录" title="刷新目录">
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </nav>

        {root === "/" && <div className="host-project-picker-warning">当前允许访问宿主机根目录，请谨慎选择项目。</div>}

        <div className="host-project-picker-list" aria-busy={loading}>
          {loading ? (
            <div className="host-project-picker-state">正在读取目录…</div>
          ) : error ? (
            <div className="host-project-picker-state is-error">{error}</div>
          ) : entries.length === 0 ? (
            <div className="host-project-picker-state">此目录为空</div>
          ) : entries.map((entry) => {
            const iconKind = getHostEntryIconKind(entry.name, entry.kind);
            const { icon: EntryIcon, label } = iconDetails[iconKind];
            const content = (
              <>
                <span className={`host-project-picker-entry-icon is-${iconKind}`} aria-hidden="true">
                  <EntryIcon size={18} strokeWidth={1.8} />
                </span>
                <span className="host-project-picker-name">{entry.name}</span>
              </>
            );
            if (entry.kind === "file") {
              return (
                <div className="host-project-picker-row is-file" key={`${entry.name}:${entry.path}`} title={label}>
                  {content}
                </div>
              );
            }
            return (
              <button type="button" className="host-project-picker-row is-directory" key={`${entry.name}:${entry.path}`} onClick={() => void loadDirectory(entry.path)} title={label}>
                {content}
                {entry.hasChildren && (
                  <span className="host-project-picker-chevron" aria-hidden="true">
                    <ChevronRight size={16} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <footer className="host-project-picker-footer">
          <code title={current}>{current}</code>
          <div>
            <button type="button" className="host-project-picker-cancel" onClick={onCancel}>取消</button>
            <button type="button" className="host-project-picker-confirm" disabled={!current || loading || confirming} onClick={() => void confirm()}>
              {confirming ? "正在导入…" : "选择此文件夹"}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
