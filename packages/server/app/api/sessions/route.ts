import { NextResponse } from "next/server";
import { normalizeToolPermissionMode } from "@agent/core";
import { agentHost, ProjectWorkingDirectoryError } from "../agent-host";
import { collaborationSessionIds } from "../../../lib/collaboration/visibility";
import { discoverSessions } from "../../../lib/session-catalog";
import {
  getNativeRuntimeService,
  runtimeErrorStatus,
} from "../../../lib/native-runtime-service";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || undefined;
  const refresh = url.searchParams.get("refresh") === "1";
  return NextResponse.json((await discoverSessions(projectId, refresh)).sessions);
}

export async function POST(request: Request) {
  const body = await request.json() as {
    title?: string;
    projectId?: string;
    cwd?: string;
    agentType?: import("../../../../core/src/domain/agent/agent-type").AgentType;
  };
  const agentType = body.agentType ?? "customer-agent";

  if (agentType !== "customer-agent") {
    try {
      if (!body.projectId && !body.cwd?.trim()) {
        throw new ProjectWorkingDirectoryError("请选择宿主机项目", "PROJECT_PATH_REQUIRED", 400);
      }
      const cwd = body.cwd?.trim()
        || (body.projectId ? await agentHost.resolveProjectWorkingDirectory(body.projectId, true) : "");
      const created = await getNativeRuntimeService().create({
        agentType,
        title: body.title ?? "新会话",
        cwd,
        ...(body.projectId ? { projectId: body.projectId } : {}),
      });
      return NextResponse.json(created, { status: 201 });
    } catch (err) {
      if (err instanceof ProjectWorkingDirectoryError) {
        return NextResponse.json(
          { error: { code: err.code, message: err.message } },
          { status: err.status },
        );
      }
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        { status: runtimeErrorStatus(err) },
      );
    }
  }

  const session = await agentHost.createSession(body.title ?? "Untitled", body.projectId ?? "");
  return NextResponse.json({ ...session, agentType: "customer-agent", messageQueueVersion: 1 }, { status: 201 });
}
