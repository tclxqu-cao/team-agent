"use client";

import { useRef, useState } from "react";
import type { PinnedCommand } from "@agent/core";
import { Check, GripVertical, Pencil, Plus, Trash2, X } from "lucide-react";
import { createPinnedCommand, movePinnedCommand } from "./pinnedCommands";

interface Props {
  commands: PinnedCommand[];
  onChange: (commands: PinnedCommand[]) => void;
  onExecute: (command: string) => void;
}

interface EditorState { id: string | null; value: string }

export default function PinnedCommandList({ commands, onChange, onExecute }: Props) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);

  const saveEditor = () => {
    if (!editor) return;
    const command = editor.value.trim();
    if (!command) return setError("命令不能为空");
    if (command.length > 1000) return setError("命令最多 1000 个字符");
    if (/[\r\n\0]/.test(command)) return setError("命令只能包含一行");
    if (editor.id) {
      onChange(commands.map((item) => item.id === editor.id ? { ...item, command } : item));
    } else {
      onChange([...commands, createPinnedCommand(command)]);
    }
    setEditor(null);
    setError("");
  };

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    dragId.current = id;
    setDraggingId(id);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const continueDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragId.current) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-pinned-id]");
    const targetId = target?.dataset.pinnedId;
    if (targetId && targetId !== dragId.current) onChange(movePinnedCommand(commands, dragId.current, targetId));
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragId.current = null;
    setDraggingId(null);
  };

  const moveWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const index = commands.findIndex((item) => item.id === id);
    const target = commands[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (target) onChange(movePinnedCommand(commands, id, target.id));
  };

  return <section className="pinned-commands" aria-labelledby="pinned-command-title">
    <div className="pinned-command-head">
      <span id="pinned-command-title">置顶命令</span>
      <button className="history-icon-button" onClick={() => { setEditor({ id: null, value: "" }); setError(""); }} aria-label="新增置顶命令" title="新增置顶命令">
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
    {commands.map((item) => editor?.id === item.id ? (
      <CommandEditor key={item.id} editor={editor!} error={error} onChange={(value) => { setEditor({ ...editor!, value }); setError(""); }} onSave={saveEditor} onCancel={() => { setEditor(null); setError(""); }} />
    ) : (
      <div
        className={`pinned-command-row${draggingId === item.id ? " pinned-command-dragging" : ""}`}
        data-pinned-id={item.id}
        key={item.id}
        role="button"
        tabIndex={0}
        onClick={() => onExecute(item.command)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onExecute(item.command); } }}
      >
        <button className="pinned-command-grip" onPointerDown={(event) => beginDrag(event, item.id)} onPointerMove={continueDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={(event) => moveWithKeyboard(event, item.id)} onClick={(event) => event.stopPropagation()} aria-label={`调整 ${item.command} 的顺序`} title="拖动排序，或按上下方向键">
          <GripVertical size={14} aria-hidden="true" />
        </button>
        <code>{item.command}</code>
        <div className="pinned-command-actions" onClick={(event) => event.stopPropagation()}>
          <button className="history-icon-button" onClick={() => { setEditor({ id: item.id, value: item.command }); setError(""); }} aria-label={`编辑 ${item.command}`} title="编辑">
            <Pencil size={12} aria-hidden="true" />
          </button>
          <button className="history-icon-button history-icon-danger" onClick={() => onChange(commands.filter((command) => command.id !== item.id))} aria-label={`删除 ${item.command}`} title="删除">
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
    ))}
    {editor?.id === null && <CommandEditor editor={editor} error={error} onChange={(value) => { setEditor({ ...editor, value }); setError(""); }} onSave={saveEditor} onCancel={() => { setEditor(null); setError(""); }} />}
  </section>;
}

function CommandEditor({ editor, error, onChange, onSave, onCancel }: {
  editor: EditorState;
  error: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return <div className="pinned-command-editor">
    <input autoFocus value={editor.value} maxLength={1000} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSave(); if (event.key === "Escape") onCancel(); }} aria-label={editor.id ? "编辑置顶命令" : "新增置顶命令"} />
    <button className="history-icon-button" onClick={onSave} aria-label="保存命令" title="保存"><Check size={13} aria-hidden="true" /></button>
    <button className="history-icon-button" onClick={onCancel} aria-label="取消编辑" title="取消"><X size={13} aria-hidden="true" /></button>
    {error && <small role="alert">{error}</small>}
  </div>;
}
