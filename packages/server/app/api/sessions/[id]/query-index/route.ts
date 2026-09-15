import { NextResponse } from "next/server";
import {
  SessionQueryIndexCache,
  isInternalGoalMessage,
  type Message,
} from "@agent/core";
import { agentHost } from "../../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
  runtimeErrorStatus,
} from "../../../../../lib/native-runtime-service";
import { rebuildMessagesFromEvents } from "../../../../../lib/session-history-source";
import { RuntimeSessionError } from "../../../../../../desktop/main/agent-runtime/types";

const localIndexCache = new SessionQueryIndexCache();

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if (isNativeSessionId(params.id)) {
    try {
      return NextResponse.json(await getNativeRuntimeService().getQueryIndex(params.id));
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Internal error",
          ...(error instanceof RuntimeSessionError ? { code: error.code } : {}),
        },
        { status: runtimeErrorStatus(error) },
      );
    }
  }

  const session = await agentHost.getSessionStore().get(params.id);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const messages = (!session.messages?.length && session.events?.length
    ? rebuildMessagesFromEvents(session.events as Array<Record<string, unknown>>)
    : session.messages)?.filter((message) => !isInternalGoalMessage(message)) ?? [];
  return NextResponse.json(localIndexCache.getOrCreate(params.id, messages as Message[]));
}
