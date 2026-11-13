import { NextResponse } from "next/server";
import {
  SessionQueryIndexCache,
  StaleSessionAnchorError,
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
import { RuntimeSessionError } from "@agent/native-runtime";
import { loadEngineThreadQueryIndex } from "../../../../../lib/engine-switch/history";

const localIndexCache = new SessionQueryIndexCache();

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if (isNativeSessionId(params.id)) {
    try {
      const thread = await loadEngineThreadQueryIndex(params.id);
      if (thread) return NextResponse.json(thread);
      return NextResponse.json(await getNativeRuntimeService().getQueryIndex(params.id));
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Internal error",
          ...(error instanceof RuntimeSessionError || error instanceof StaleSessionAnchorError ? { code: error.code } : {}),
        },
        { status: error instanceof StaleSessionAnchorError ? 409 : runtimeErrorStatus(error) },
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
