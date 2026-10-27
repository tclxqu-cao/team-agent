import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw, Square, Terminal, X } from "lucide-react";
import type { RuntimeBackgroundJob, RuntimeBackgroundJobOutput } from "../global";
import { useSessionBackgroundJobs } from "../lib/use-session-background-jobs";
import ElapsedTime from "./ElapsedTime";

const statusLabels: Record<RuntimeBackgroundJob["status"], string> = {
  running: "运行中", stopping: "正在停止", completed: "已完成", killed: "已终止", failed: "失败",
};

function JobOutput({ sessionId, jobId }: { sessionId: string; jobId: string }) {
  const [value, setValue] = useState<RuntimeBackgroundJobOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const api = window.agentApi;
        if (!api?.getSessionBackgroundJobOutput) throw new Error("当前服务未提供任务输出接口，请更新服务");
        const next = await api.getSessionBackgroundJobOutput(sessionId, jobId);
        if (!disposed) { setValue(next); setError(null); }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "任务输出读取失败");
      } finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3_000);
    document.addEventListener("visibilitychange", poll);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [sessionId, jobId]);
  return <div className="background-jobs__output">
    {error && <p className="background-jobs__error" role="alert">{error}</p>}
    {value?.truncated && <p>仅展示最近的输出</p>}
    <pre aria-label="任务实时输出">{value ? value.output || "暂无输出，任务可能正在等待或未输出进度。" : error ? "暂时无法读取输出" : "正在读取输出…"}</pre>
  </div>;
}

export default function SessionBackgroundJobs({ sessionId }: { sessionId: string }) {
  const state = useSessionBackgroundJobs(sessionId);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const panelId = `${titleId}-panel`;
  const active = state.jobs.filter(job => job.status === "running" || job.status === "stopping").length;
  const close = () => {
    setOpen(false);
    setExpanded(null);
    triggerRef.current?.focus({ preventScroll: true });
  };
  return <div className="background-jobs" onKeyDown={event => {
    if (open && event.key === "Escape") { event.stopPropagation(); close(); }
  }}>
    <button ref={triggerRef} type="button" className="background-jobs__trigger"
      onClick={() => { if (open) close(); else setOpen(true); }} aria-expanded={open} aria-controls={panelId}>
      <Terminal size={14} aria-hidden="true" />后台任务
      <span aria-live="polite">{state.error ? "连接异常" : state.loading ? "读取中" : active ? `${active} 个运行中` : `${state.jobs.length} 个任务`}</span>
    </button>
    {open && <section id={panelId} className="background-jobs__panel" aria-labelledby={titleId}>
        <header><h2 id={titleId}>后台任务</h2>
          <button type="button" aria-label="刷新后台任务" title="刷新" onClick={() => { void state.refresh(); }}><RefreshCw size={17} /></button>
          <button type="button" aria-label="关闭后台任务" onClick={close}><X size={20} /></button>
        </header>
        <p className="background-jobs__hint">当前会话可见的任务。终止单个任务后，DeepSeek 会收到任务结束通知。</p>
        <div className="background-jobs__list">
          {(state.error || state.actionError) && <p className="background-jobs__error" role="alert">{state.actionError || state.error}</p>}
          {!state.jobs.length && !state.error && <p className="background-jobs__empty">{state.loading ? "正在读取后台任务…" : "当前没有后台任务"}</p>}
          {state.jobs.map(job => <article key={job.id} className="background-jobs__item" data-status={job.status}>
            <div className="background-jobs__meta">
              <span className="background-jobs__status">{statusLabels[job.status]}</span>
              {job.scope === "shared" && <span>共享任务</span>}
              {job.status === "running" || job.status === "stopping"
                ? <ElapsedTime startedAt={job.startedAt} />
                : job.finishedAt !== undefined && <span>{Math.max(0, Math.round((job.finishedAt - job.startedAt) / 1000))} 秒</span>}
              {(job.canStop || job.status === "stopping" || state.stopping.has(job.id)) && <button
                type="button" className="background-jobs__stop" disabled={!job.canStop || state.stopping.has(job.id)}
                aria-label={`终止任务：${job.label}`} onClick={() => { void state.stop(job.id); }}>
                <Square size={12} aria-hidden="true" />{job.status === "stopping" ? "正在停止" : state.stopping.has(job.id) ? "停止已请求" : "终止任务"}
              </button>}
            </div>
            <p className="background-jobs__command">{job.label}</p>
            {job.detail && <p className="background-jobs__detail">{job.detail}</p>}
            <button type="button" className="background-jobs__output-toggle" aria-expanded={expanded === job.id}
              onClick={() => setExpanded(expanded === job.id ? null : job.id)}>{expanded === job.id ? "收起输出" : "查看输出"}</button>
            {expanded === job.id && <JobOutput key={`${sessionId}:${job.id}`} sessionId={sessionId} jobId={job.id} />}
          </article>)}
        </div>
    </section>}
  </div>;
}
