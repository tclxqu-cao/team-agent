import { useEffect, useState, type FormEvent } from "react";
import { isNativeAgentType, NATIVE_AGENT_TYPES } from "../../../core/src/domain/agent/agent-type";
import type { TodoCommand, TodoDetail, TodoTrigger } from "@agent/core";
import { AGENT_LABELS } from "../lib/agent-catalog";

type SaveSchedule = (command: Extract<TodoCommand, { type: "schedule" }>) => Promise<void>;

export default function TodoScheduleEditor({ detail, onSave, onClose }: {
  detail: TodoDetail & { schedule: NonNullable<TodoDetail["schedule"]> };
  onSave: SaveSchedule;
  onClose: () => void;
}) {
  const { task, schedule } = detail;
  const recurring = schedule.trigger.kind === "cron";
  const [agentType, setAgentType] = useState(schedule.target.agentType);
  const [time, setTime] = useState(() => {
    if (schedule.trigger.kind === "cron") return schedule.trigger.expression;
    const local = new Date(schedule.trigger.at);
    return new Date(local.getTime() - local.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  });
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void window.agentApi?.getRuntimeHealth?.().then(health => {
      if (active) setUnavailable(health.filter(agent => !agent.available).map(agent => agent.agentType));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const trigger: TodoTrigger = recurring ? { kind: "cron", expression: time.trim() } : { kind: "once", at: new Date(time).getTime() };
    if (trigger.kind === "once" && (!Number.isFinite(trigger.at) || (enabled && trigger.at <= Date.now()))) {
      setError("请选择有效的未来执行时间");
      return;
    }
    setSaving(true);
    setError("");
    const target = schedule.target;
    const targetPatch = agentType === target.agentType ? undefined : { agentType, cwd: target.cwd, permissionMode: target.permissionMode };
    const timeChanged = trigger.kind === "once" && schedule.trigger.kind === "once"
      ? trigger.at !== schedule.trigger.at : trigger.kind === "cron" && schedule.trigger.kind === "cron" && trigger.expression !== schedule.trigger.expression;
    try {
      await onSave({ type: "schedule", taskId: task.id, expectedVersion: task.version, enabled,
        ...(targetPatch ? { target: targetPatch } : {}), ...(timeChanged ? { trigger } : {}) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "执行计划保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <form className="cal-schedule-editor" onSubmit={submit} aria-label="编辑执行计划">
    <label>执行 Agent
      <select value={agentType} onChange={event => setAgentType(event.target.value)} disabled={saving}>
        {!isNativeAgentType(schedule.target.agentType) && <option value={schedule.target.agentType}>{schedule.target.agentType}</option>}
        {NATIVE_AGENT_TYPES.map(type => <option key={type} value={type} disabled={unavailable.includes(type) && type !== schedule.target.agentType}>{AGENT_LABELS[type]}</option>)}
      </select>
    </label>
    <label>{recurring ? `执行规则（${schedule.timeZone}）` : "执行时间（本地时间）"}
      <input type={recurring ? "text" : "datetime-local"} step={recurring ? undefined : 1} value={time} required disabled={saving} onChange={event => setTime(event.target.value)} />
    </label>
    <label className="cal-schedule-enabled"><input type="checkbox" checked={enabled} disabled={saving} onChange={event => setEnabled(event.target.checked)} />启用执行计划</label>
    {error && <p role="alert">{error}</p>}
    <div className="cal-schedule-actions">
      <button type="button" className="cal-nav-btn" onClick={onClose} disabled={saving}>取消</button>
      <button type="submit" className="cal-nav-btn" disabled={saving}>{saving ? "保存中" : "保存"}</button>
    </div>
  </form>;
}
