import { ShieldCheck } from "lucide-react";
import type { CollaborationGroup } from "../../../../core/src/domain/collaboration/types";
import { postDashboardIntent } from "../../../../core/src/domain/web-console/SessionDashboardBridge";

export default function GroupSupervisionSummary({ group }: { group: CollaborationGroup }) {
  if (!group.monitoring?.targets.length) return null;
  const supervisor = group.members.find(member => member.id === group.monitoring?.supervisorId);
  return <div className="collab-supervision-summary"><ShieldCheck size={14}/><span>{supervisor ? `监工 ${supervisor.name}` : "已关联"} · {group.monitoring.targets.length} 条原始会话</span><button onClick={() => postDashboardIntent({ kind: "dashboard" })}>查看监工与决策</button></div>;
}
