import { useEffect, useState } from "react";
import { Check, Pencil, Play, Target, Trash2, X } from "lucide-react";
import type { NativeGoalMutation, NativeGoalRef, NativeSessionGoal } from "../global";

interface NativeGoalBarProps {
  goal: NativeSessionGoal | null;
  pending: boolean;
  error: string | null;
  onMutate: (mutation: NativeGoalMutation) => Promise<unknown>;
}

export function NativeGoalBar({ goal, pending, error, onMutate }: NativeGoalBarProps) {
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [rounds, setRounds] = useState("");
  const [editRef, setEditRef] = useState<NativeGoalRef | null>(null);
  useEffect(() => { setEditing(false); }, [goal?.id]);
  if (!goal) return error ? <div className="native-goal-error" role="alert">{error}</div> : null;
  const ref = { id: goal.id, revision: goal.revision };
  const armed = goal.phase === "active" && goal.activation === "armed";
  const status = goal.phase === "active" ? armed ? "推进中" : "待恢复"
    : { paused: "已暂停", blocked: "已受阻", complete: "已完成" }[goal.phase];
  const submit = async (mutation: NativeGoalMutation) => {
    try { await onMutate(mutation); if (mutation.action === "edit") setEditing(false); }
    catch { /* The selected-session controller presents the native error. */ }
  };
  return <div className={`goal-queue thread-goal is-${goal.phase}`} aria-label="DeepSeek Harness 目标">
    <div className="goal-queue__header">
      <Target size={14} aria-hidden="true" /><span>目标</span>
      <span className="goal-queue__count">{status}</span>
      <span className="thread-goal__usage">{goal.roundsStarted}/{goal.maxGoalRounds} 轮</span>
    </div>
    {editing ? <form className="native-goal-edit" onSubmit={event => {
      event.preventDefault();
      if (!pending && editRef && objective.trim() && Number.isSafeInteger(Number(rounds)) && Number(rounds) > 0) {
        void submit({ action: "edit", ref: editRef, objective, maxGoalRounds: Number(rounds) });
      }
    }}>
      <input aria-label="目标内容" value={objective} onChange={event => setObjective(event.target.value)} disabled={pending} />
      <label>轮数上限<input type="number" min="1" step="1" aria-label="目标轮数上限" value={rounds} onChange={event => setRounds(event.target.value)} disabled={pending} /></label>
      <button className="goal-queue__action" type="submit" aria-label="保存目标" title="保存目标" disabled={pending || !objective.trim() || !Number.isSafeInteger(Number(rounds)) || Number(rounds) < 1}><Check size={14} /></button>
      <button className="goal-queue__action" type="button" aria-label="取消编辑目标" title="取消编辑" disabled={pending} onClick={() => setEditing(false)}><X size={14} /></button>
    </form> : <div className="goal-queue__row is-active">
      <span className="goal-queue__objective" title={goal.objective}>{goal.objective}</span>
      {armed && <button className="goal-queue__action" type="button" disabled={pending} aria-label="暂停目标续跑" title="暂停目标续跑" onClick={() => { void submit({ action: "pause", ref }); }}>⏸</button>}
      {!armed && goal.phase !== "complete" && <button className="goal-queue__action" type="button" disabled={pending} aria-label="恢复目标续跑" title="恢复目标续跑" onClick={() => { void submit({ action: "resume", ref }); }}><Play size={12} /></button>}
      <button className="goal-queue__action" type="button" disabled={pending} aria-label="编辑目标" title="编辑目标" onClick={() => { setObjective(goal.objective); setRounds(String(goal.maxGoalRounds)); setEditRef(ref); setEditing(true); }}><Pencil size={12} /></button>
      {goal.phase !== "complete" && <button className="goal-queue__action" type="button" disabled={pending} aria-label="标记目标完成" title="标记目标完成" onClick={() => { void submit({ action: "complete", ref }); }}><Check size={12} /></button>}
      <button className="goal-queue__action" type="button" disabled={pending} aria-label="清除目标，停止续跑" title="清除目标，停止续跑" onClick={() => { void submit({ action: "clear", ref }); }}><Trash2 size={12} /></button>
    </div>}
    {goal.blockedReason && <div className="native-goal-error">{goal.blockedReason.message}</div>}
    {error && <div className="native-goal-error" role="alert">{error}</div>}
  </div>;
}
