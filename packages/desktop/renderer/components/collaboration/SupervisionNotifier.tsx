import { usePageActive, isPageActive } from "../../lib/page-activity";
import { useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import type { SupervisionAlert } from "../../../../core/src/domain/supervision/types";
import { postDashboardIntent } from "../../lib/dashboard-navigation-delivery";
import { collaborationRequest } from "./client";
import DashboardDecision from "./DashboardDecision";
import "./session-dashboard.css";

export default function SupervisionNotifier({ onOpen }: { onOpen: () => void }) {
  const active = usePageActive();
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());
  const pending = pendingIds.length;
  const showPending = pendingIds.some(id => !dismissedIds.has(id));
  const [notice, setNotice] = useState("");
  const [decision, setDecision] = useState<SupervisionAlert | null>(null);
  const refreshAlerts = useRef<() => Promise<void>>(async () => {});
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!active) return;
    let live = true, loading = false;
    try { seen.current = new Set(JSON.parse(localStorage.getItem("agentroam:supervision-notifications") ?? "[]")); } catch { /* Optional storage. */ }
    const refresh = async () => {
      if (loading || !isPageActive()) return;
      loading = true;
      try {
        const alerts = await collaborationRequest<SupervisionAlert[]>({ action: "supervisionAlerts" });
        if (!live) return;
        setPendingIds(alerts.filter(alert => alert.incident.status === "waiting").map(alert => alert.incident.id));
        setDecision(current => current ? alerts.find(alert => alert.incident.id === current.incident.id && alert.incident.status === "waiting") ?? null : null);
        const fresh = alerts.filter(alert => !seen.current.has(`${alert.incident.id}:${alert.incident.status}`));
        if (fresh.length) {
          const alert = fresh.at(-1)!;
          setNotice(`${alert.groupName} · ${alert.incident.status === "waiting" ? "需要你决策" : alert.incident.kind === "handoff" ? "交接已衔接" : alert.incident.kind === "delivery" ? "交付已确认" : "异常已恢复"}`);
          const actionable = fresh.find(alert => alert.incident.status === "waiting" && alert.target);
          if (actionable) setDecision(current => current ?? actionable);
          for (const alert of fresh) seen.current.add(`${alert.incident.id}:${alert.incident.status}`);
          seen.current = new Set([...seen.current].slice(-300));
          try { localStorage.setItem("agentroam:supervision-notifications", JSON.stringify([...seen.current])); } catch { /* Optional storage. */ }
        }
      } catch { /* The existing service connection UI reports transport failures. */ }
      finally { loading = false; }
    };
    refreshAlerts.current = refresh;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 7000);
    return () => { live = false; clearInterval(timer); };
  }, [active]);
  useEffect(() => { if (!notice || showPending) return; const timer = setTimeout(() => setNotice(""), 10000); return () => clearTimeout(timer); }, [notice, showPending]);
  const dismiss = () => {
    setDismissedIds(current => new Set([...current, ...pendingIds]));
    setDecision(null);
    setNotice("");
  };
  if (!showPending && !notice) return null;
  return <aside className={`supervision-notice${decision ? " is-expanded" : ""}`} aria-label="监工提醒" role="status"><div className="supervision-notice-heading"><button onClick={onOpen}><Bell size={16}/><span>{showPending ? `监工有 ${pending} 项待你决策` : notice}</span></button><button aria-label="关闭监工提醒" onClick={dismiss}><X size={14}/></button></div>
    {decision?.target && <div className="session-dashboard supervision-notice-content"><strong>{decision.groupName} · {decision.incident.sessionTitle}</strong><DashboardDecision text={decision.incident.message} options={decision.incident.question?.options ?? decision.incident.options} recommendation={decision.incident.recommendation} multiSelect={decision.incident.question?.multiSelect} sourceOnly={decision.incident.question?.requiresSource}
      onSource={() => postDashboardIntent({ kind: "session", session: decision.target! })}
      onAnswer={async (answer, selectedIndices) => { await collaborationRequest({ action: "answerSupervision", groupId: decision.incident.groupId, incidentId: decision.incident.id, answer, selectedIndices }); setDecision(null); setNotice(""); await refreshAlerts.current(); }}/></div>}
  </aside>;
}
