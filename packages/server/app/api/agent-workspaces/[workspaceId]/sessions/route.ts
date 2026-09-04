import { NextResponse } from "next/server";
import { normalizeToolPermissionMode } from "@agent/core";
import { paginateByOffset } from "../../../../../../desktop/main/agent-runtime/agent-workspace-index";
import type { WorkspaceSessionQuery } from "../../../../../../desktop/main/agent-runtime/types";
import { agentHost } from "../../../agent-host";
import { getNativeRuntimeService, runtimeErrorStatus } from "../../../../../lib/native-runtime-service";
import { readAgentType, readWorkspaceQuery } from "../../route";

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
    const project = await agentHost.getProjectStore().get(context.params.workspaceId);
    if (!project) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    const sessions = await agentHost.getSessionStore().list(project.id);
    const summaries = sessions
      .map(({ messages: _messages, events: _events, ...session }) => ({
        ...session,
        agentType: "customer-agent" as const,
        nativeSessionId: session.id,
        cwd: project.description,
        occupancy: agentHost.isSessionRunning(session.id)
          ? "owned-by-customer-agent" as const
          : "available" as const,
        sourceLabel: "Customer Agent",
        canResume: true,
        canDelete: !agentHost.isSessionRunning(session.id),
        permissionMode: normalizeToolPermissionMode(session.metadata.permissionMode),
      }))
      .sort((left, right) => right.updated.localeCompare(left.updated));
    return NextResponse.json(paginateByOffset(summaries, query, summaries[0]?.updated ?? project.updated));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Workspace sessions failed" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
