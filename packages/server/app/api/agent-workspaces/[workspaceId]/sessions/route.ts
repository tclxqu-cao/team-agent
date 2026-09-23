import { NextResponse } from "next/server";
import { normalizeToolPermissionMode } from "@agent/core";
import { paginateByOffset, type WorkspaceSessionQuery } from "@agent/native-runtime";
import { agentHost } from "../../../agent-host";
import { getNativeRuntimeService, runtimeErrorStatus } from "../../../../../lib/native-runtime-service";
import {
  CUSTOMER_AGENT_RECENT_WORKSPACE_ID,
  readAgentType,
  readWorkspaceQuery,
} from "../../agent-workspace-http";

export async function GET(
  request: Request,
  context: { params: { workspaceId: string } },
) {
  const url = new URL(request.url);
  const agentType = readAgentType(url.searchParams.get("agentType"));
  if (!agentType) {
    return NextResponse.json({ error: "A valid agentType is required" }, { status: 400 });
  }
  let query: WorkspaceSessionQuery;
  try {
    const parsed = readWorkspaceQuery(url);
    query = { cursor: parsed.cursor, limit: parsed.limit, refresh: parsed.refresh };
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid query" }, { status: 400 });
  }
  try {
    if (agentType !== "customer-agent") {
      return NextResponse.json(
        await getNativeRuntimeService().listWorkspaceSessions(agentType, context.params.workspaceId, query),
      );
    }
    let cwd = "";
    let fallbackWatermark: string | null = null;
    let sessions;
    if (context.params.workspaceId === CUSTOMER_AGENT_RECENT_WORKSPACE_ID) {
      const [projects, allSessions] = await Promise.all([
        agentHost.getProjectStore().list(),
        agentHost.getSessionStore().list(),
      ]);
      const visibleProjectIds = new Set(
        projects
          .filter((project) => project.description.trim().length > 0)
          .map((project) => project.id),
      );
      sessions = allSessions.filter((session) => !visibleProjectIds.has(session.projectId));
    } else {
      const project = await agentHost.getProjectStore().get(context.params.workspaceId);
      if (!project) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
      if (!project.description.trim()) {
        return NextResponse.json(
          { error: "该项目没有宿主机目录", code: "PROJECT_PATH_REQUIRED" },
          { status: 400 },
        );
      }
      cwd = project.description;
      fallbackWatermark = project.updated;
      sessions = await agentHost.getSessionStore().list(project.id);
    }
    const summaries = sessions
      .map(({ messages: _messages, events: _events, ...session }) => ({
        ...session,
        projectId: context.params.workspaceId,
        agentType: "customer-agent" as const,
        nativeSessionId: session.id,
        cwd,
        occupancy: agentHost.isSessionRunning(session.id)
          ? "owned-by-customer-agent" as const
          : "available" as const,
        sourceLabel: "Customer Agent",
        canResume: true,
        canDelete: !agentHost.isSessionRunning(session.id),
        permissionMode: normalizeToolPermissionMode(session.metadata.permissionMode),
      }))
      .sort((left, right) => right.updated.localeCompare(left.updated));
    return NextResponse.json(paginateByOffset(summaries, query, summaries[0]?.updated ?? fallbackWatermark));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Workspace sessions failed" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
