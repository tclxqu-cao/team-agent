import { NextResponse } from "next/server";
import {
  isToolPermissionMode,
  normalizeToolPermissionMode,
  paginateSessionHistory,
  StaleSessionAnchorError,
  type Message,
} from "@agent/core";
import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
  runtimeErrorStatus,
} from "../../../../lib/native-runtime-service";
import { RuntimeSessionError } from "../../../../../desktop/main/agent-runtime/types";
import { rebuildMessagesFromEvents } from "../../../../lib/session-history-source";

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const url = new URL(request.url);
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const anchor = url.searchParams.get("anchor");
  const limit = url.searchParams.get("limit");
  const historyQuery = before !== null || after !== null || anchor !== null || limit !== null
    ? {
        before: before || undefined,
        after: after || undefined,
        anchor: anchor || undefined,
        limit: parseHistoryLimit(limit),
      }
    : undefined;
  if (isNativeSessionId(params.id)) {
    try {
      const detail = await getNativeRuntimeService().get(params.id, historyQuery);
      return NextResponse.json(detail);
    } catch (err) {
      return NextResponse.json(
        {
          error: err instanceof Error ? err.message : "Internal error",
          ...(err instanceof RuntimeSessionError ? { code: err.code } : {}),
        },
        { status: runtimeErrorStatus(err) },
      );
    }
  }

  const session = await agentHost.getSessionStore().get(params.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const rebuiltMessages = !session.messages?.length && Array.isArray(session.events) && session.events.length > 0
    ? rebuildMessagesFromEvents(session.events as Array<Record<string, unknown>>)
    : session.messages;

  try {
    const hydrated = historyQuery
      ? {
          ...session,
          permissionMode: normalizeToolPermissionMode(session.metadata.permissionMode),
          ...paginateSessionHistory(
            (rebuiltMessages ?? []) as Message[],
            session.events ?? [],
            historyQuery,
          ),
        }
      : {
          ...session,
          messages: rebuiltMessages,
          permissionMode: normalizeToolPermissionMode(session.metadata.permissionMode),
        };
    return NextResponse.json(hydrated);
  } catch (error) {
    if (error instanceof StaleSessionAnchorError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    throw error;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const body = await request.json() as { permissionMode?: unknown };
  if (!isToolPermissionMode(body.permissionMode)) {
    return NextResponse.json({ error: "Invalid permission mode" }, { status: 400 });
  }
  if (isNativeSessionId(params.id)) {
    try {
      const session = await getNativeRuntimeService().setPermissionMode(params.id, body.permissionMode);
      return NextResponse.json(session);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Unable to update permission mode" },
        { status: runtimeErrorStatus(error) },
      );
    }
  }
  try {
    const session = await agentHost.setSessionPermissionMode(params.id, body.permissionMode);
    return NextResponse.json({
      ...session,
      permissionMode: normalizeToolPermissionMode(session.metadata.permissionMode),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update permission mode";
    const status = message.startsWith("Session not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function parseHistoryLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if (isNativeSessionId(params.id)) {
    try {
      await getNativeRuntimeService().delete(params.id);
      return NextResponse.json({ status: "deleted" });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Unable to delete session" },
        { status: runtimeErrorStatus(error) },
      );
    }
  }
  if (agentHost.isSessionRunning(params.id)) {
    return NextResponse.json(
      { error: "Session is currently running" },
      { status: 409 },
    );
  }
  await agentHost.getSessionStore().delete(params.id);
  return NextResponse.json({ status: "deleted" });
}
