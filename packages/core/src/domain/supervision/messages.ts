import type { CollaborationGroup } from "../collaboration/types.js";
import type { SupervisionIncident, SupervisionMessage } from "./types.js";

/** The same saved incident projection is used for live updates and legacy history. */
export function incidentMessage(group: CollaborationGroup, incident: SupervisionIncident, historical = false): SupervisionMessage {
  const supervisor = group.members.find(member => member.id === group.monitoring?.supervisorId);
  const titles: Record<SupervisionIncident["status"], string> = {
    evaluating: "正在巡检", queued: "接续指令排队中", executing: "正在介入", verifying: "等待核对新进度",
    resolved: "已处理", waiting: "等待你决策", dismissed: "此项已结束",
  };
  const target = group.monitoring?.targets.find(target => target.id === incident.sessionId);
  return {
    id: `incident:${group.id}:${incident.id}:${incident.updatedAt}:${incident.status}:${incident.attempts}`,
    groupId: group.id, direction: "activity", title: titles[incident.status],
    sender: supervisor?.name ?? "监工", senderAgentType: supervisor?.agentType,
    content: incident.message, createdAt: incident.updatedAt,
    incidentId: incident.id, sessionId: incident.sessionId, sessionTitle: incident.sessionTitle,
    cwd: target?.cwd ?? group.cwd, status: incident.status, ...(historical ? { historical: true } : {}),
  };
}
