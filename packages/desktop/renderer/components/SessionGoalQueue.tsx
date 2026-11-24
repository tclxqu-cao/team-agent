import { useRef, useState } from "react";
import { Check, CornerUpRight, LoaderCircle, Pencil, Target, Trash2, X } from "lucide-react";
import type { SessionGoalState } from "@agent/core";

type GoalDraft = { goalId: string; objective: string };

interface SessionGoalQueueProps {
  active: SessionGoalState["active"];
  queued: SessionGoalState["queued"];
  onEdit: (goalId: string, objective: string) => Promise<void>;
  insertion?: { mode: "current" | "next"; submit: (goalId: string) => Promise<void> };
  onRemove: (goalId: string) => Promise<void>;
  onReorder: (sourceId: string, targetId: string) => Promise<void>;
}

export default function SessionGoalQueue({ active, queued, onEdit, insertion, onRemove, onReorder }: SessionGoalQueueProps) {
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [inserting, setInserting] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const pointerDrag = useRef<{ pointerId: number; goalId: string } | null>(null);
  const rows = active ? [active, ...queued] : queued;
  const savingRef = useRef(false);
  const save = async () => {
    if (!draft || !draft.objective.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onEdit(draft.goalId, draft.objective);
      setDraft(null);
    } catch { /* The conversation renders the operation error. Keep the input for retry. */ }
    finally { savingRef.current = false; setSaving(false); }
  };
  const insert = async (id: string) => {
    if (savingRef.current || !insertion) return;
    savingRef.current = true;
    setInserting(id);
    try { await insertion.submit(id); }
    finally { savingRef.current = false; setInserting(null); }
  };
  if (!rows.length) return null;
  const busy = saving || inserting !== null;

  const renderEditor = (editor: GoalDraft) => (
    <form key={editor.goalId} className="queued-message-row" onSubmit={event => { event.preventDefault(); void save(); }}>
      <span className="queued-message-grip session-goal-marker"><Target size={15} aria-hidden="true" /></span>
      <div className="queued-message-content">
        <input autoFocus value={editor.objective} disabled={saving} maxLength={4000} className="queued-message-edit-input"
          aria-label="编辑目标内容"
          onChange={event => setDraft({ ...editor, objective: event.target.value })}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault();
            if (!saving && event.key === "Escape") { event.preventDefault(); setDraft(null); }
          }} />
      </div>
      <div className="queued-message-actions">
        <button type="submit" className="queued-message-action" disabled={saving || !editor.objective.trim()} aria-label="保存目标" title="保存目标"><Check size={15} aria-hidden="true" /></button>
        <button type="button" className="queued-message-action" disabled={saving} onClick={() => setDraft(null)} aria-label="取消目标修改" title="取消"><X size={15} aria-hidden="true" /></button>
      </div>
    </form>
  );

  return <div className="queued-message-list" aria-label="目标队列" data-tab-swipe-ignore>
    {rows.map(goal => {
      const isActive = goal.id === active?.id;
      const editor = draft?.goalId === goal.id ? draft : null;
      if (editor) return renderEditor(editor);
      const isNext = insertion?.mode === "next" && goal.id === queued[0]?.id;
      const insertLabel = insertion?.mode === "current" ? "插入到当前对话" : isNext ? "已排在下一条" : "插入为下一条目标";
      return (
        <div key={goal.id} className={`queued-message-row${dragging === goal.id ? " is-dragging" : ""}`}
          data-queued-goal-id={isActive ? undefined : goal.id}
          onDragOver={event => {
            if (!dragging || isActive || dragging === goal.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={event => {
            if (!dragging || isActive || dragging === goal.id) return;
            event.preventDefault();
            setDragging(null);
            void onReorder(dragging, goal.id);
          }}>
          {isActive ? <span className="queued-message-grip session-goal-marker" role="img" aria-label="目标进行中" title="进行中"><Target size={15} aria-hidden="true" /></span>
            : <button type="button" className="queued-message-grip" draggable={!draft && !busy}
              aria-label="拖动调整目标顺序" title="拖动调整目标顺序"
              onDragStart={event => {
                setDragging(goal.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", goal.id);
              }}
              onDragEnd={() => setDragging(null)}
              onKeyDown={event => {
                if (draft || busy || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                event.preventDefault();
                const target = queued[queued.findIndex(item => item.id === goal.id) + (event.key === "ArrowUp" ? -1 : 1)];
                if (target) void onReorder(goal.id, target.id);
              }}
              onPointerDown={event => {
                if (draft || busy || event.pointerType === "mouse") return;
                pointerDrag.current = { pointerId: event.pointerId, goalId: goal.id };
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging(goal.id);
              }}
              onPointerUp={event => {
                const pointer = pointerDrag.current;
                if (!pointer || pointer.pointerId !== event.pointerId) return;
                pointerDrag.current = null;
                setDragging(null);
                const target = document.elementFromPoint(event.clientX, event.clientY)
                  ?.closest<HTMLElement>("[data-queued-goal-id]")?.dataset.queuedGoalId;
                if (target && target !== pointer.goalId) void onReorder(pointer.goalId, target);
              }}
              onLostPointerCapture={() => { pointerDrag.current = null; setDragging(null); }}>
              <Target size={15} aria-hidden="true" />
            </button>}
          <div className="queued-message-content"><span className="queued-message-text" title={goal.objective}>{goal.objective}</span></div>
          <div className="queued-message-actions">
            {!isActive && insertion && <button type="button" className="queued-message-action queued-message-action--accent"
              disabled={busy || !!draft || isNext} aria-label={insertLabel} title={insertLabel} onClick={() => { void insert(goal.id); }}>
              {inserting === goal.id ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <CornerUpRight size={15} aria-hidden="true" />}
            </button>}
            <button type="button" className="queued-message-action" disabled={busy} aria-label="编辑目标" title="编辑目标"
              onClick={() => setDraft({ goalId: goal.id, objective: goal.objective })}><Pencil size={15} aria-hidden="true" /></button>
            <button type="button" className="queued-message-action queued-message-action--danger" disabled={busy}
              aria-label={isActive ? "停止当前目标" : "删除排队目标"} title={isActive ? "停止当前目标" : "删除目标"}
              onClick={() => { void onRemove(goal.id); }}><Trash2 size={15} aria-hidden="true" /></button>
          </div>
        </div>
      );
    })}
  </div>;
}
