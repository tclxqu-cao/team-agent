import { NextResponse } from "next/server";
import type { AgentEvent } from "@agent/core";
import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
} from "../../../../lib/native-runtime-service";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      input: string;
      sessionId?: string;
      images?: string[];
      model?: { provider: string; apiKey: string; modelId: string; baseUrl?: string };
      reasoningEffort?: "off" | "low" | "medium" | "high";
    };

    if (!body.input) {
      return NextResponse.json({ error: "input is required" }, { status: 400 });
    }

    if (body.sessionId && isNativeSessionId(body.sessionId)) {
      const sessionId = body.sessionId;
      const service = getNativeRuntimeService();
      agentHost.resetExternalStream(sessionId);
      void (async () => {
        try {
          for await (const event of service.run(sessionId, body.input, body.images)) {
            agentHost.publishExternal(sessionId, event);
          }
        } catch (err) {
          agentHost.publishExternal(sessionId, {
            type: "error",
            message: err instanceof Error ? err.message : "Native run failed",
          } as AgentEvent);
        }
      })();
      return NextResponse.json({
        sessionId,
        streamUrl: `/api/agent/stream?sessionId=${sessionId}`,
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

    // Configure model if provided
    if (body.model) {
      agentHost.getBuilder().withModel(body.model.provider, {
        apiKey: body.model.apiKey,
        modelId: body.model.modelId,
        baseUrl: body.model.baseUrl,
      });
    }

    agentHost.getBuilder().withReasoningEffort(body.reasoningEffort ?? "off");

    // Run agent in background
    agentHost.run(body.input, sessionId, body.images).catch((err) => {
      console.error("Agent run error:", err);
    });

    return NextResponse.json({
      sessionId: session.id,
      streamUrl: `/api/agent/stream?sessionId=${session.id}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
