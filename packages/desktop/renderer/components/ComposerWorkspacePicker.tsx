import { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, FolderOpen } from "lucide-react";
import { useComposerPickerHeight } from "../lib/use-composer-picker-height";

export interface ComposerWorkspace {
  id: string;
  name: string;
  path: string;
  canCreateSession?: boolean;
}

interface ComposerWorkspacePickerProps {
  value: string | null;
  workspaces: ComposerWorkspace[];
  onChange: (projectId: string) => void;
  onPickFolder?: () => void;
  /** Test-only hook so the menu can be asserted without a click; production stays collapsed. */
  defaultOpen?: boolean;
}

function pathBasename(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
}

/** Collapsed-button copy: current workspace name, then path basename, then the empty label. */
export function workspacePickerLabel(value: string | null, workspaces: readonly ComposerWorkspace[]): { label: string; path?: string } {
  const current = workspaces.find((workspace) => workspace.id === value);
  if (current) return { label: current.name || pathBasename(current.path) || "选择目录", path: current.path };
  const fallback = value ? pathBasename(value) : "";
  return fallback ? { label: fallback, path: value ?? undefined } : { label: "选择目录" };
}

export default function ComposerWorkspacePicker({ value, workspaces, onChange, onPickFolder, defaultOpen = false }: ComposerWorkspacePickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const wrapRef = useRef<HTMLDivElement>(null);
  const maxHeight = useComposerPickerHeight(open, wrapRef);
  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([aria-disabled="true"]):not(:disabled)'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length]?.focus();
  };

  const { label, path } = workspacePickerLabel(value, workspaces);
  const hasWorkspaces = workspaces.length > 0;
  return (
    <div className="composer-workspace-picker" ref={wrapRef} data-composer-workspace-picker={value ?? ""}>
      <button
        type="button"
        className="composer-workspace-picker-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`目录：${label}，点击切换`}
        title={label}
        onClick={() => setOpen((next) => !next)}
      >
        <Folder size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className="composer-picker-label" title={path ? `${label}（${path}）` : undefined}>{label}</span>
        <ChevronDown className="composer-picker-chevron" size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div className="composer-workspace-picker-menu" role="menu" aria-label="选择目录" style={{ maxHeight }} onKeyDown={handleMenuKeyDown}>
          {workspaces.map((workspace) => {
            const blocked = workspace.canCreateSession === false;
            const selected = workspace.id === value;
            return (
              <button
                key={workspace.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={blocked || undefined}
                data-workspace-id={workspace.id}
                title={blocked ? `${workspace.path}（仅历史会话，无法新建）` : workspace.path}
                className={[selected ? "is-active" : "", blocked ? "is-unavailable" : ""].filter(Boolean).join(" ") || undefined}
                onClick={() => {
                  if (blocked) return;
                  onChange(workspace.id);
                  setOpen(false);
                }}
              >
                <span className="composer-picker-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                <span className="composer-picker-copy">
                  <strong>{workspace.name}</strong>
                  <small>{workspace.path || "仅历史会话"}</small>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="menuitem"
            className="composer-workspace-picker-action"
            disabled={!onPickFolder}
            onClick={() => {
              setOpen(false);
              onPickFolder?.();
            }}
          >
            <FolderOpen size={16} strokeWidth={1.8} aria-hidden="true" />
            {hasWorkspaces ? "选择其他文件夹…" : "选择文件夹…"}
          </button>
        </div>
      )}
    </div>
  );
}
