import { AGENT_TYPES, SQLiteCollaborationRepository, type DashboardGroup, type SessionDashboardSnapshot, monitoringConfiguration } from "@agent/core";
import { getServerBaseDir } from "../server-data-dir";
import { catalogSessions } from "../session-catalog";
import { supervisionService } from "../supervision/service";
import { collaborationSessionIds } from "./visibility";

export async function sessionDashboard(): Promise<SessionDashboardSnapshot> {
  const repository = new SQLiteCollaborationRepository(getServerBaseDir());
  const rows = repository.dashboardDiscussions();
  const { sessions, discoveryError } = await catalogSessions(true);
  const byId = new Map(sessions.map(session => [session.id, session]));
  const hidden = collaborationSessionIds();
  const supervision = supervisionService();
  const groups: DashboardGroup[] = repository.listGroups().map(group => {
    const discussions = rows.filter(row => row.groupId === group.id);
    const scope = supervision.repository.get(group.id) ?? undefined;
    const questions = discussions.flatMap<DashboardGroup["questions"][number]>(row => row.questions.length
      ? row.questions.map(question => ({ discussionId: row.id, questionId: question.id, text: question.text, options: question.options, decisionRevision: undefined }))
      : row.status === "waiting" ? [{ discussionId: row.id, questionId: `discussion:${row.id}:${row.revision}`, text: row.progress || "群主需要你的决定，请回复后继续。", options: undefined, decisionRevision: row.revision }] : []);
    const pending = scope?.incidents.filter(incident => incident.status === "waiting") ?? [];
    const linked = scope?.group.monitoring?.targets ?? group.monitoring?.targets ?? [];
    const groupSessions = linked.length ? linked.map(target => ({ ...target, status: byId.get(target.id)?.status ?? "unknown" }))
      : [...new Set(discussions.flatMap(row => Object.values(row.sessions)))].map(id => byId.get(id)).filter((session): session is NonNullable<typeof session> => !!session);
    const active = discussions.find(row => row.questions.length || ["running", "waiting", "stopping"].includes(row.status));
    const recent = active ?? discussions[0];
    const runningCount = discussions.reduce((count, row) => count + row.runningCount + Number(row.status === "running" && !row.runningCount), 0) + linked.filter(target => byId.get(target.id)?.status === "running").length;
    const decisionCount = questions.length + pending.length;
    return {
      group, status: decisionCount ? "waiting" : runningCount ? "running" : recent?.status ?? "idle",
      updated: [recent?.updatedAt, scope?.incidents.at(-1)?.updatedAt, group.createdAt].filter((value): value is string => !!value).sort().at(-1)!,
      progress: pending[0]?.message ?? scope?.incidents.at(-1)?.message ?? recent?.progress ?? "尚未开始讨论",
      runningCount, decisionCount, discussionId: recent?.id, questions, sessions: groupSessions, supervision: scope,
      configurationChanged: scope ? monitoringConfiguration(group) !== monitoringConfiguration(scope.group) : false,
    };
  });
  groups.sort((a, b) => Number(["running", "waiting"].includes(b.status)) - Number(["running", "waiting"].includes(a.status)) || b.updated.localeCompare(a.updated) || a.group.id.localeCompare(b.group.id));
  return {
    groups: groups.slice(0, 10), groupTotal: groups.length, decisionTotal: groups.reduce((count, group) => count + group.decisionCount, 0),
    agents: AGENT_TYPES.map(agentType => ({ agentType, sessions: sessions.filter(session => session.agentType === agentType && session.status === "running" && !hidden.has(session.id)).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)) })),
    updatedAt: new Date().toISOString(), discoveryError,
  };
}
