import { NextResponse } from "next/server";
import type { AgentEvent } from "@agent/core";
import { RuntimeSessionError } from "../../../../../desktop/main/agent-runtime/types.js";
import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
} from "../../../../lib/native-runtime-service";
import { normalizeCustomerAgentRunOptions } from "./run-options";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      input: string;
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

    const runOptions = normalizeCustomerAgentRunOptions(body);
    const builder = agentHost.getBuilder()
      .withMaxIterations(runOptions.maxIterations)
      .withMaxTokens(runOptions.maxTokens)
      .withReasoningEffort(body.reasoningEffort ?? "off");

    // Configure model if provided
    if (body.model) {
      builder.withModel(body.model.provider, {
        apiKey: body.model.apiKey,
        modelId: body.model.modelId,
        baseUrl: body.model.baseUrl,
      });
    }

    // Run agent in background
    agentHost.run(body.input, sessionId, body.images).catch((err) => {
      console.error("Agent run error:", err);
    });

    return NextResponse.json({
      sessionId: session.id,
      streamUrl: `/api/agent/stream?sessionId=${session.id}`,
    });
  } catch (err) {
    const code = err instanceof RuntimeSessionError ? err.code : undefined;
    const isConflict = code === "SESSION_OCCUPIED" || code === "SESSION_ALREADY_RUNNING";
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Internal error",
        ...(code ? { code } : {}),
      },
      { status: isConflict ? 409 : 500 },
    );
  }
}
