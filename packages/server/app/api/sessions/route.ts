import { NextResponse } from "next/server";
import { agentHost } from "../agent-host";
import {
  getNativeRuntimeService,
  runtimeErrorStatus,
} from "../../../lib/native-runtime-service";
import { getAgentWorkingDirectory } from "../../../lib/server-data-dir";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || undefined;
  const refresh = url.searchParams.get("refresh") === "1";
  const sessions = await agentHost.getSessionStore().list(projectId);

  const service = getNativeRuntimeService();
  // The renderer treats a missing agentType as a native runtime, so CA
  // sessions must be tagged explicitly; canDelete drives the sidebar × button.
  const tagged = sessions.map((session) => ({
    ...session,
    agentType: "customer-agent" as const,
    canDelete: true,
  }));
  try {
    // Native sessions carry no projectId on this server (it registers no
    // projects), so project-scoped queries return only customer-agent
    // sessions; unfiltered queries merge natives for "其他本机会话".
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
    agentType?: "customer-agent" | "codex" | "claude-code";
  };
  const agentType = body.agentType ?? "customer-agent";

  if (agentType !== "customer-agent") {
    try {
      const created = await getNativeRuntimeService().create({
        agentType,
        title: body.title ?? "新会话",
        cwd: getAgentWorkingDirectory(),
      });
      return NextResponse.json(created, { status: 201 });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        { status: runtimeErrorStatus(err) },
      );
    }
  }

  const session = await agentHost.createSession(body.title ?? "Untitled", body.projectId ?? "");
  return NextResponse.json(session, { status: 201 });
}
