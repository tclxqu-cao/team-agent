import { NextResponse } from "next/server";
import { paginateByOffset, type AgentType, type AgentWorkspace, type WorkspaceQuery } from "@agent/native-runtime";
import { agentHost } from "../agent-host";
import { getNativeRuntimeService, runtimeErrorStatus } from "../../../lib/native-runtime-service";
import { projectErrorResponse, webProjectService } from "../projects/project-http";
import { removedWorkspaceStore } from "../../../lib/removed-workspace-store";
import {
  CUSTOMER_AGENT_RECENT_WORKSPACE_ID,
  readAgentType,
  readWorkspaceQuery,
} from "./agent-workspace-http";

async function workspacePage(agentType: AgentType, query: WorkspaceQuery) {
  if (agentType !== "customer-agent") {
    return getNativeRuntimeService().listWorkspaces(agentType, query);
  }
  const projects = (await agentHost.getProjectStore().list())
    .filter((project) => project.description.trim().length > 0 && !project.id.startsWith("collaboration-"));
  const workspaces: AgentWorkspace[] = [{
    agentType,
    workspaceId: CUSTOMER_AGENT_RECENT_WORKSPACE_ID,
    name: "最近",
    roots: [],
    order: -1,
    source: "derived",
    canCreateSession: false,
  }, ...projects.map((project, order): AgentWorkspace => ({
    agentType,
    workspaceId: project.id,
    name: project.name,
    roots: project.description ? [project.description] : [],
    order,
    updatedAt: project.updated,
    source: "native",
  }))];
  return paginateByOffset(workspaces, query, projects[0]?.updated ?? null);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const agentType = readAgentType(url.searchParams.get("agentType"));
  if (!agentType) {
    return NextResponse.json({ error: "A valid agentType is required" }, { status: 400 });
  }
  let query: WorkspaceQuery;
  try {
    query = readWorkspaceQuery(url);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid query" }, { status: 400 });
  }
  try {
    const page = await workspacePage(agentType, query);
    return NextResponse.json({ ...page, data: removedWorkspaceStore().visible(page.data) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Workspace discovery failed" },
      { status: runtimeErrorStatus(error) },
    );
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const agentType = readAgentType(url.searchParams.get("agentType"));
  const workspaceId = url.searchParams.get("workspaceId");
  if (!agentType || !workspaceId) {
    return NextResponse.json({ error: "A valid agentType and workspaceId are required" }, { status: 400 });
  }
  try {
    let cursor: string | null = null;
    do {
      const page = await workspacePage(agentType, { cursor, limit: 200, refresh: true });
      const workspace = page.data.find((row) => row.workspaceId === workspaceId);
      if (workspace) {
        removedWorkspaceStore().remove(workspace);
        return NextResponse.json({ removed: true, workspaceId });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return NextResponse.json({ error: "目录不存在，请刷新目录列表" }, { status: 404 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "目录删除失败" },
      { status: (error as { status?: number }).status ?? runtimeErrorStatus(error) },
    );
  }
}

export async function POST(request: Request) {
  let body: { agentType?: string; path?: string; name?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "A JSON body is required" }, { status: 400 });
  }
  const agentType = readAgentType(body.agentType ?? null);
  if (!agentType || !body.path?.trim()) {
    return NextResponse.json({ error: "A valid agentType and path are required" }, { status: 400 });
  }
  try {
    const canonicalPath = webProjectService.canonicalDirectory(body.path);
    if (agentType !== "customer-agent") {
      const result = await getNativeRuntimeService().importWorkspace(agentType, canonicalPath, body.name);
      removedWorkspaceStore().restore(agentType, canonicalPath);
      return NextResponse.json(
        result,
        { status: 201 },
      );
    }
    const before = await webProjectService.list();
    const project = await webProjectService.create(canonicalPath, body.name);
    removedWorkspaceStore().restore(agentType, canonicalPath);
    return NextResponse.json({
      workspace: {
        agentType,
        workspaceId: project.id,
        name: project.name,
        roots: project.description ? [project.description] : [],
        order: Math.max(0, before.findIndex((candidate) => candidate.id === project.id)),
        updatedAt: project.updated,
        source: "native",
      } satisfies AgentWorkspace,
      existing: before.some((candidate) => candidate.id === project.id),
    }, { status: 201 });
  } catch (error) {
    const projectError = projectErrorResponse(error);
    if (projectError.status !== 500) {
      return NextResponse.json(projectError.body, { status: projectError.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Workspace import failed" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
