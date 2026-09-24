import { X } from "lucide-react";
import type { FileWorkspaceGateway } from "../../../../core/src/application/file-workspace/FileWorkspaceGateway";
import FilePreview from "./FilePreview";
import FileTree from "./FileTree";
import type { FileTreeRevealRequest } from "./fileTreeReveal";

export type FileWorkspaceDrawerTab = "files" | "history";

interface Props {
  open: boolean;
  tab: FileWorkspaceDrawerTab;
  gateway: FileWorkspaceGateway;
  cwd: string | null;
  selectedPath: string | null;
  revealRequest: FileTreeRevealRequest | null;
  onTabChange: (tab: FileWorkspaceDrawerTab) => void;
  onSelectPath: (path: string | null) => void;
  onClose: () => void;
}

export default function FileWorkspaceDrawer({
  open,
  tab,
  gateway,
  cwd,
  selectedPath,
  revealRequest,
  onTabChange,
  onSelectPath,
  onClose,
}: Props) {
  if (!open) return null;
  return (
    <section
      className={`desktop-file-workspace${selectedPath ? " has-preview" : ""}`}
      aria-label="我的文件"
    >
      <aside className="desktop-file-drawer">
        <header className="desktop-file-drawer-header">
          <div className="desktop-file-drawer-tabs" role="tablist" aria-label="文件工作区视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "files"}
              className={tab === "files" ? "is-active" : ""}
              onClick={() => onTabChange("files")}
            >文件</button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "history"}
              className={tab === "history" ? "is-active" : ""}
              onClick={() => onTabChange("history")}
            >历史</button>
          </div>
          <button type="button" className="desktop-file-workspace-close ui-icon-button ui-icon-button--small" onClick={onClose} aria-label="关闭我的文件" title="关闭">
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        {tab === "files" ? (
          cwd ? (
            <FileTree
              gateway={gateway}
              ready
              followCwd
              cwd={cwd}
              onOpenFile={(path) => onSelectPath(path)}
              selectedPath={selectedPath}
              revealRequest={revealRequest}
            />
          ) : (
            <div className="desktop-file-workspace-empty">请先选择一个项目目录</div>
          )
        ) : (
          <div className="desktop-file-workspace-empty">
            <strong>终端历史在 Web 控制台中可用</strong>
            <span>Electron 当前没有终端上下文，因此不会提供填入或执行操作。</span>
          </div>
        )}
        <footer className="desktop-file-drawer-footer"><span />实时同步</footer>
      </aside>
      {selectedPath && (
        <div className="desktop-file-preview">
          <FilePreview path={selectedPath} gateway={gateway} onClose={() => onSelectPath(null)} />
        </div>
      )}
    </section>
  );
}
