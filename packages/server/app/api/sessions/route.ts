import { NextResponse } from "next/server";
import { normalizeToolPermissionMode } from "@agent/core";
import { agentHost, ProjectWorkingDirectoryError } from "../agent-host";
import {
  getNativeRuntimeService,
  runtimeErrorStatus,
} from "../../../lib/native-runtime-service";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || undefined;
  const refresh = url.searchParams.get("refresh") === "1";
  const sessions = await agentHost.getSessionStore().list(projectId);

  const service = getNativeRuntimeService();
  // The renderer treats a missing agentType as a native runtime, so CA
  // sessions must be tagged explicitly; canDelete drives the sidebar × button.
  const tagged = sessions.map(({ messages: _messages, events: _events, ...session }) => ({
    ...session,
    agentType: "customer-agent" as const,
    messageQueueVersion: 1 as const,
    canDelete: !agentHost.isSessionRunning(session.id),
    permissionMode: normalizeToolPermissionMode(session.metadata.permissionMode),
  }));
  try {
    // Native discovery associates cwd with the most specific registered
    // project path, matching the desktop renderer's project tree.
    const native = refresh ? await service.refresh(projectId) : await service.list(projectId);
    return NextResponse.json([...tagged, ...native]);
  } catch (err) {
    console.error("Native session discovery failed:", err);
    // Discovery failure must not hide the customer-agent session list.
    return NextResponse.json(tagged);
  }
}

export async function POST(request: Request) {
  const body = await request.json() as {
    title?: string;
    projectId?: string;
    cwd?: string;
    agentType?: "customer-agent" | "codex" | "claude-code" | "opencode";
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
