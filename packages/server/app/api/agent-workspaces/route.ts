import { NextResponse } from "next/server";
import { paginateByOffset } from "../../../../desktop/main/agent-runtime/agent-workspace-index";
import type {
  AgentType,
  AgentWorkspace,
  WorkspaceQuery,
} from "../../../../desktop/main/agent-runtime/types";
import { agentHost } from "../agent-host";
import { getNativeRuntimeService, runtimeErrorStatus } from "../../../lib/native-runtime-service";
import { projectErrorResponse, webProjectService } from "../projects/project-http";

const AGENT_TYPES = new Set<AgentType>(["customer-agent", "codex", "claude-code", "opencode"]);

export function readAgentType(value: string | null): AgentType | null {
  return value && AGENT_TYPES.has(value as AgentType) ? value as AgentType : null;
}

export function readWorkspaceQuery(url: URL): WorkspaceQuery {
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("limit must be an integer between 1 and 200");
  }
  return {
    cursor: url.searchParams.get("cursor"),
    since: url.searchParams.get("since"),
    refresh: url.searchParams.get("refresh") === "1",
    limit,
  };
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
    if (agentType !== "customer-agent") {
      return NextResponse.json(await getNativeRuntimeService().listWorkspaces(agentType, query));
    }
    const projects = await agentHost.getProjectStore().list();
    const workspaces = projects.map((project, order): AgentWorkspace => ({
      agentType,
      workspaceId: project.id,
      name: project.name,
      roots: project.description ? [project.description] : [],
      order,
      updatedAt: project.updated,
      source: "native",
    }));
    return NextResponse.json(paginateByOffset(workspaces, query, workspaces[0]?.updatedAt ?? null));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Workspace discovery failed" },
      { status: runtimeErrorStatus(error) },
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
      return NextResponse.json(
        await getNativeRuntimeService().importWorkspace(agentType, canonicalPath, body.name),
        { status: 201 },
      );
    }
    const before = await webProjectService.list();
    const project = await webProjectService.create(canonicalPath, body.name);
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
