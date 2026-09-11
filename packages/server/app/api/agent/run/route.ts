import { NextResponse } from "next/server";
import type { AgentEvent } from "@agent/core";
import { RuntimeSessionError } from "../../../../../desktop/main/agent-runtime/types.js";
import { agentHost, CustomerAgentRunConflictError } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
} from "../../../../lib/native-runtime-service";
import { normalizeCustomerAgentRunOptions } from "./run-options";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      input: string;
      agentIds?: string[];
      sessionId?: string;
      images?: string[];
      model?: { provider: string; apiKey: string; modelId: string; baseUrl?: string };
      reasoningEffort?: "off" | "low" | "medium" | "high";
      maxIterations?: number;
      maxTokens?: number;
      nativeModel?: { id: string; providerID?: string };
      nativeReasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    };

    if (!body.input) {
      return NextResponse.json({ error: "input is required" }, { status: 400 });
    }
    if (body.agentIds !== undefined && (!Array.isArray(body.agentIds) || body.agentIds.length > 20 || body.agentIds.some((id) => typeof id !== "string" || !id.trim()))) {
      return NextResponse.json({ error: "agentIds must contain at most 20 non-empty IDs" }, { status: 400 });
    }

    if (body.sessionId && isNativeSessionId(body.sessionId)) {
      const sessionId = body.sessionId;
      const service = getNativeRuntimeService();
      // Reserve the broker run before replacing any replay state. A rejected
      // duplicate send must leave the live turn and the renderer draft intact.
      const admission = await service.startRun(sessionId, body.input, body.images, "web", {
        ...(body.nativeModel?.id ? { model: body.nativeModel } : {}),
        ...(body.nativeReasoningEffort ? { reasoningEffort: body.nativeReasoningEffort } : {}),
      });
      agentHost.resetExternalStream(sessionId);
      agentHost.publishExternal(sessionId, {
        type: "run_admitted",
        _nativeRunId: admission.runId,
        _nativeSequence: admission.snapshotRevision,
      } as unknown as AgentEvent);
      let unsubscribe: (() => void) | null = null;
      let terminalSeen = false;
      void service.subscribe(sessionId, 0, ({ event }) => {
        agentHost.publishExternal(sessionId, event);
        if (event.type === "done" || event.type === "error") {
          terminalSeen = true;
          unsubscribe?.();
        }
      }).then((stop) => {
        unsubscribe = stop;
        if (terminalSeen) stop();
      }).catch((err) => {
        const code = err instanceof RuntimeSessionError ? err.code : undefined;
        agentHost.publishExternal(sessionId, {
          type: "error",
          message: err instanceof Error ? err.message : "Native run subscription failed",
          ...(code ? { code } : {}),
        } as AgentEvent);
      });
      return NextResponse.json({
        sessionId,
        streamUrl: `/api/agent/stream?sessionId=${sessionId}`,
        runId: admission.runId,
        snapshotRevision: admission.snapshotRevision,
      });
    }

    const sessionId = body.sessionId ?? crypto.randomUUID();
    const sessionStore = agentHost.getSessionStore();
    let session = await sessionStore.get(sessionId);
    if (!session) {
      const now = new Date().toISOString();
      session = await sessionStore.create({
        id: sessionId,
        projectId: "",
        title: `Chat ${now}`,
        status: "idle",
        messages: [],
        events: [],
        created: now,
        updated: now,
        metadata: {},
      });
    }

    const limits = normalizeCustomerAgentRunOptions(body);
    // Browser/Desktop use persisted settings. Explicit SDK overrides remain
    // scoped to this run instead of mutating a shared builder.
    const started = agentHost.startRun(body.input, sessionId, body.images, {
      ...(body.model ? { model: body.model } : {}),
      ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
      ...(body.maxIterations === undefined ? {} : { maxIterations: limits.maxIterations }),
      ...(body.maxTokens === undefined ? {} : { maxTokens: limits.maxTokens }),
      ...(body.agentIds ? { agentIds: body.agentIds } : {}),
    });
    started.completion.catch((err) => {
      console.error("Agent run error:", err);
    });

    return NextResponse.json({
      sessionId: session.id,
      streamUrl: `/api/agent/stream?sessionId=${session.id}`,
      runId: started.runId,
    });
  } catch (err) {
    const code = err instanceof RuntimeSessionError ? err.code : undefined;
    const customerAgentCode = err instanceof CustomerAgentRunConflictError ? err.code : undefined;
    const resolvedCode = code ?? customerAgentCode;
    const isConflict = resolvedCode === "SESSION_OCCUPIED" || resolvedCode === "SESSION_ALREADY_RUNNING";
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Internal error",
        ...(resolvedCode ? { code: resolvedCode } : {}),
      },
      { status: isConflict ? 409 : 500 },
    );
  }
}
